import { Agent, fetch as undiciFetch } from "undici";
import type { Connector } from "./undiciConnect.ts";
import { isBlockedHostName } from "./hostPolicy.ts";
import { AppError } from "./appError.ts";
import {
  SsrfBlockedError,
  assertPublicUrl,
  isPolicyRefusal,
} from "../../server/ssrfGuard.js";

export type SafeFetchOptions = Omit<RequestInit, "redirect"> & {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  truncate?: boolean;
};

export type SafeFetchDeps = {
  lookup?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
};

export type SafeFetchResult = {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
  truncated: boolean;
  text(): string;
  json<T>(): T;
};

const DEFAULT_MAX_BYTES = 5_242_880;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_BODY_HARD_CAP = 64 * 1024 * 1024;

// A customer URL that cannot be reached is the customer's problem, not ours:
// per §6.2 an unusable target is 422 `url_unreachable`, so a refused connection,
// a reset, a DNS failure or the fetch timeout must not escape as a raw error and
// surface as a 500.
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
]);

function isUnreachable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { name?: unknown; code?: unknown; cause?: unknown };
  if (record.name === "TimeoutError" || record.name === "AbortError") return true;
  if (typeof record.code === "string" && UNREACHABLE_CODES.has(record.code)) return true;
  if (record.cause && record.cause !== err) return isUnreachable(record.cause);
  return false;
}

function toAppError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (err instanceof SsrfBlockedError) {
    if (isPolicyRefusal(err)) {
      throw new AppError(422, "url_blocked", "That address cannot be fetched.");
    }
    throw new AppError(422, "url_unreachable", "That address could not be reached.");
  }
  if (isUnreachable(err)) {
    throw new AppError(422, "url_unreachable", "That address could not be reached.");
  }
  throw err;
}

function readBodyText(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function makeResult(
  url: string,
  status: number,
  headers: Headers,
  body: Uint8Array,
  truncated: boolean
): SafeFetchResult {
  return {
    url,
    status,
    headers,
    body,
    truncated,
    text: () => readBodyText(body),
    json<T>(): T {
      return JSON.parse(readBodyText(body)) as T;
    },
  };
}

type Transport = {
  fetch: (url: string, init: Record<string, unknown>) => Promise<Response>;
  close: () => void;
};

// Connection pinning closes the TOCTOU gap documented in ssrfGuard.js: every
// hop builds an undici Agent whose connector rewrites the connection hostname
// to the address assertPublicUrl vetted, instead of re-resolving the name. A
// resolver that later answers a private address cannot redirect the
// connection: undici dials the vetted IP and still performs the normal TLS
// handshake with the original SNI servername. The injected fetchImpl test
// seam deliberately bypasses the pin: no test double resolves DNS, so there
// is nothing to pin, and production never passes fetchImpl.
function pinTransport(
  vetted: { hostname: string; addresses: string[]; url: URL },
  fetchImpl?: typeof fetch
): Transport {
  if (fetchImpl) {
    return {
      fetch: (url, init) => fetchImpl(url, init as RequestInit),
      close: () => undefined,
    };
  }
  // Every vetted address, in order: `assertPublicUrl` cleared all of them, so a
  // dual-stack name whose first record is an AAAA on IPv4-only egress, or a
  // multi-A CDN with one dead node, still connects through one of the others
  // instead of failing the whole fetch on `addresses[0]`.
  const addresses = vetted.addresses.length > 0 ? vetted.addresses : [vetted.hostname];
  const pinnedConnect: Connector = ((opts: {
    hostname?: string;
    host?: string;
    protocol?: string;
    port?: string | number;
    servername?: string;
  }, callback: (err: Error | null, socket: unknown) => void) => {
      // Dial the vetted address; undici keeps the request's own Host header,
      // port and (for https) SNI servername, so virtual hosting and TLS
      // verification are unaffected. Verified: http returns 200 with the
      // original Host header, and https completes against a local TLS server
      // with SNI intact.
      void Promise.all([import("node:net"), import("node:tls")]).then(([{ connect }, { connect: tlsConnect }]) => {
        const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
        // undici's connect callback is one-shot. Once it has been handed a
        // socket, a later socket error belongs to the request, not to the
        // connection attempt, so the handlers are detached and the callback is
        // never invoked twice.
        let done = false;
        const attempt = (index: number): void => {
          if (done) return;
          let socket: import("node:net").Socket;
          try {
            socket = connect({ host: addresses[index], port });
          } catch (err) {
            if (index + 1 < addresses.length) {
              attempt(index + 1);
              return;
            }
            done = true;
            callback(err as Error, null);
            return;
          }
          const onConnectError = (err: Error): void => {
            if (done) return;
            socket.destroy();
            if (index + 1 < addresses.length) {
              attempt(index + 1);
              return;
            }
            done = true;
            callback(err, null);
          };
          const succeed = (handed: unknown): void => {
            if (done) return;
            done = true;
            socket.removeListener("error", onConnectError);
            callback(null, handed);
          };
          socket.once("connect", () => {
            if (opts.protocol === "https:") {
              const servername = opts.servername || opts.hostname || vetted.hostname;
              const tls = tlsConnect({ socket, servername });
              const onTlsError = (err: Error): void => {
                tls.destroy();
                onConnectError(err);
              };
              tls.once("secureConnect", () => {
                tls.removeListener("error", onTlsError);
                succeed(tls);
              });
              tls.once("error", onTlsError);
            } else {
              succeed(socket);
            }
          });
          socket.once("error", onConnectError);
        };
        attempt(0);
      });
    }) as Connector;
  const agent = new Agent({ connect: pinnedConnect });
  return {
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>,
    close: () => {
      void agent.close().catch(() => undefined);
    },
  };
}

function snapshotHeaders(from: Headers): Headers {
  const headers = new Headers();
  from.forEach((value, key) => {
    try {
      headers.set(key, value);
    } catch {
      // A duplicate set-cookie collapses to the last value; hop headers are informational.
    }
  });
  return headers;
}

async function readCapped(
  response: Response,
  maxBytes: number,
  truncate: boolean
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.length > maxBytes && !truncate) {
      throw new AppError(422, "response_too_large", "The response was larger than the limit.");
    }
    return buf.length > maxBytes ? { bytes: buf.slice(0, maxBytes), truncated: true } : { bytes: buf, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      if (total + value.length > maxBytes) {
        if (!truncate) {
          await reader.cancel().catch(() => undefined);
          throw new AppError(422, "response_too_large", "The response was larger than the limit.");
        }
        const room = maxBytes - total;
        if (room > 0) {
          chunks.push(value.slice(0, room));
          total += room;
        }
        await reader.cancel().catch(() => undefined);
        return { bytes: concat(chunks, total), truncated: true };
      }
      chunks.push(value);
      total += value.length;
    }
  }
  return { bytes: concat(chunks, total), truncated: false };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Fetch standard: a 303 always becomes a GET, and a 301/302 answering a POST
// does too (every browser does this). 307/308 keep the method and the body.
function dropsBody(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";
  if (status === 301 || status === 302) return method === "POST";
  return false;
}

function isReplayableBody(body: BodyInit): boolean {
  if (typeof body === "string") return true;
  if (body instanceof URLSearchParams) return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  return false;
}

function withoutBodyHeaders(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers) return headers;
  const next = new Headers(headers);
  next.delete("content-length");
  next.delete("content-type");
  next.delete("content-encoding");
  return next;
}

export async function safeFetch(
  url: string,
  init: SafeFetchOptions = {},
  deps: SafeFetchDeps = {}
): Promise<SafeFetchResult> {
  const {
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    truncate = false,
    ...fetchInit
  } = init;
  if (!Number.isFinite(maxBytes) || maxBytes < 1 || maxBytes > MAX_BODY_HARD_CAP) {
    throw new AppError(500, "safe_fetch_config_invalid", "The safeFetch body cap is out of range.");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new AppError(500, "safe_fetch_config_invalid", "The safeFetch redirect budget is out of range.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new AppError(500, "safe_fetch_config_invalid", "The safeFetch timeout is out of range.");
  }

  const lookup = deps.lookup;
  const deadline = Date.now() + timeoutMs;
  let current = url;
  // Per-hop method and body, because a redirect is not a replay of the original
  // request: a 303 (and a 301/302 on POST) becomes a GET without a body, per the
  // fetch standard, and a body that can only be read once cannot be sent twice.
  let method = typeof fetchInit.method === "string" ? fetchInit.method.toUpperCase() : "GET";
  let requestBody: BodyInit | null = (fetchInit.body as BodyInit | null | undefined) ?? null;
  let requestHeaders = fetchInit.headers;

  for (let hop = 0; ; hop += 1) {
    let vetted: { url: URL; hostname: string; addresses: string[] };
    try {
      // HostPolicy names are checked first: defence in depth for *.internal
      // and friends before ssrfGuard's address checks run.
      let rawHostname = "";
      try {
        rawHostname = new URL(current).hostname;
      } catch {
        rawHostname = "";
      }
      if (rawHostname && isBlockedHostName(rawHostname)) {
        throw new SsrfBlockedError(`Refused host name: ${rawHostname}.`, { code: "blocked_host" });
      }
      vetted = await assertPublicUrl(current, lookup ? { lookup } : {});
    } catch (err) {
      toAppError(err);
    }

    const transport = pinTransport(vetted!, deps.fetchImpl);
    try {
      const response = await transport.fetch(vetted!.url.toString(), {
        ...fetchInit,
        method,
        body: requestBody,
        headers: requestHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      });
      const headers = snapshotHeaders(response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (maxRedirects === 0 && hop === 0) {
          // Not followed: a 3xx is returned as-is with its Location intact.
          return makeResult(vetted!.url.toString(), response.status, headers, new Uint8Array(0), false);
        }
        if (!location) {
          throw new AppError(422, "url_unreachable", "That address could not be reached.");
        }
        if (hop >= maxRedirects) {
          throw new AppError(422, "url_blocked", "That address cannot be fetched.");
        }
        if (dropsBody(response.status, method)) {
          method = "GET";
          requestBody = null;
          requestHeaders = withoutBodyHeaders(requestHeaders);
        } else if (requestBody !== null && !isReplayableBody(requestBody)) {
          // A stream body is already consumed by the first hop; sending it again
          // throws deep inside undici. Say so instead.
          throw new AppError(
            500,
            "safe_fetch_redirect_body",
            "A streamed request body cannot follow a redirect."
          );
        }
        current = new URL(location, vetted!.url.toString()).toString();
        continue;
      }
      const body = await readCapped(response, maxBytes, truncate);
      return makeResult(vetted!.url.toString(), response.status, headers, body.bytes, body.truncated);
    } catch (err) {
      toAppError(err);
    } finally {
      transport.close();
    }
  }
}

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_REDIRECTS, DEFAULT_TIMEOUT_MS };
