import { Agent, fetch as undiciFetch } from "undici";
import type { Connector } from "./undiciConnect.ts";
import { isBlockedHostName } from "./hostPolicy.ts";
import { AppError } from "./appError.ts";
import {
  SsrfBlockedError,
  assertPublicUrl,
  isPolicyRefusal,
} from "../ssrfGuard.js";

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

function toAppError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (err instanceof SsrfBlockedError) {
    if (isPolicyRefusal(err)) {
      throw new AppError(422, "url_blocked", "That address cannot be fetched.");
    }
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
  const first = vetted.addresses[0];
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
        let socket: import("node:net").Socket;
        try {
          socket = connect({ host: first, port: Number(opts.port) || (opts.protocol === "https:" ? 443 : 80) });
        } catch (err) {
          callback(err as Error, null);
          return;
        }
        socket.once("connect", () => {
          if (opts.protocol === "https:") {
            const servername = opts.servername || opts.hostname || vetted.hostname;
            const tls = tlsConnect({ socket, servername });
            tls.once("secureConnect", () => callback(null, tls));
            tls.once("error", (err: Error) => callback(err, null));
          } else {
            callback(null, socket);
          }
        });
        socket.once("error", (err: Error) => callback(err, null));
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
