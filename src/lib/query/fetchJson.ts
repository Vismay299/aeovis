/**
 * F05 §6.2 — the one browser-side JSON fetch helper.
 *
 * Pure module: relative imports only, erasable syntax only, so `node --test`
 * runs it. `fetch` is injectable through `deps` so tests never touch the
 * network. Only `status`, `ok` and `json()` are read from the response.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly recovery?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: { recovery?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (extra?.recovery !== undefined) this.recovery = extra.recovery;
    if (extra?.details !== undefined) this.details = extra.details;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export type JsonSchema<T> = { parse(value: unknown): T };

export type FetchJsonInit<T> = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  schema?: JsonSchema<T>;
};

let unauthorizedHandler: (() => void) | null = null;

/** Registered once by the portal shell (F05 phase 3); `null` clears it. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

const NETWORK_ERROR_MESSAGE =
  "Could not reach Perceev. Check your connection and try again.";
const INVALID_RESPONSE_MESSAGE = "The server sent an unexpected response.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "AbortError"
  );
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === "string" ? value : undefined;
}

export async function fetchJson<T = unknown>(
  url: string,
  init: FetchJsonInit<T> = {},
  deps: { fetch?: typeof fetch } = {},
): Promise<T> {
  const doFetch = deps.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  const request: RequestInit = {
    method: init.method ?? "GET",
    headers,
    cache: "no-store",
    credentials: "same-origin",
  };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(init.body);
  }
  if (init.signal) request.signal = init.signal;

  let response: Response;
  try {
    response = await doFetch(url, request);
  } catch (e) {
    if (isAbortError(e)) throw e;
    if (e instanceof TypeError) {
      throw new ApiError(0, "network_error", NETWORK_ERROR_MESSAGE);
    }
    throw e;
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const status = response.status;
    const code =
      stringField(body, "code") ??
      (status === 401 ? "unauthenticated" : `http_${status}`);
    const message =
      stringField(body, "error") ??
      stringField(body, "detail") ??
      `The request failed (${status}).`;
    const recovery = stringField(body, "recovery");
    const details =
      isRecord(body) && isRecord(body.details) ? body.details : undefined;
    if (status === 401) unauthorizedHandler?.();
    throw new ApiError(status, code, message, { recovery, details });
  }

  if (init.schema) {
    try {
      return init.schema.parse(body);
    } catch {
      // Never include the body in the error or a log.
      throw new ApiError(
        response.status,
        "invalid_response",
        INVALID_RESPONSE_MESSAGE,
      );
    }
  }
  return body as T;
}

export function withBrand(
  path: string,
  brandKey: string,
  params?: Record<string, string | number | boolean | undefined | null>,
): string {
  const query: string[] = [`brand_key=${encodeURIComponent(brandKey)}`];
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    query.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return `${path}${path.includes("?") ? "&" : "?"}${query.join("&")}`;
}
