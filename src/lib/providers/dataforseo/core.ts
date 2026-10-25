// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/core.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../http/appError.ts";
import {
  AmbiguousCallError,
  UnbilledCallError,
} from "../../spend/errors.ts";
import type {
  DataforseoResponseLike,
  DataforseoTaskLike,
} from "./envelope.ts";

export const DATAFORSEO_API_BASE = "https://api.dataforseo.com";
export const DATAFORSEO_SANDBOX_BASE = "https://sandbox.dataforseo.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 170_000;
const GET_RETRIES = 2;
const GET_RETRY_BACKOFF_MS = 250;

export type DataforseoErrorClassifier = (
  status: number | undefined,
  details: string,
  path: string,
) => Error | null;

export type DataforseoRequestOptions = {
  classify?: DataforseoErrorClassifier;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

function pathOnly(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  return noQuery.startsWith("/") ? noQuery : "/" + noQuery;
}

function apiKeyFrom(env: Record<string, string | undefined>): string {
  const value = env.DATAFORSEO_API_KEY?.trim();
  if (!value) {
    throw new AppError(
      503,
      "dataforseo_not_configured",
      "DataForSEO is not configured.",
    );
  }
  return value;
}

function requestSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
}

function failure(
  method: "GET" | "POST",
  status: number,
): Error {
  if (status === 401) {
    return new UnbilledCallError("DataForSEO authentication failed.");
  }
  if (status === 402) {
    return new UnbilledCallError("The DataForSEO account has a billing or balance issue.");
  }
  if (status === 429) {
    return new UnbilledCallError("DataForSEO rate limit reached.");
  }
  if (status >= 500) {
    if (method === "POST") {
      return new AmbiguousCallError("DataForSEO may have billed this request.");
    }
    return new AppError(
      503,
      "dataforseo_unavailable",
      "DataForSEO is temporarily unavailable.",
    );
  }
  return new UnbilledCallError("DataForSEO refused the request.");
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function request<T extends DataforseoTaskLike>(
  method: "GET" | "POST",
  path: string,
  tasks: unknown[] | undefined,
  options: DataforseoRequestOptions,
): Promise<DataforseoResponseLike<T> | null> {
  const env = options.env ?? process.env;
  const apiKey = apiKeyFrom(env);
  const baseUrl =
    options.baseUrl ?? env.DATAFORSEO_BASE_URL ?? DATAFORSEO_API_BASE;
  if (baseUrl !== DATAFORSEO_API_BASE && baseUrl !== DATAFORSEO_SANDBOX_BASE) {
    throw new AppError(
      500,
      "dataforseo_base_url_invalid",
      "DATAFORSEO_BASE_URL must use the DataForSEO API or sandbox host.",
    );
  }

  const endpoint = pathOnly(path);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const signal = requestSignal(timeoutMs, options.signal);
  const headers = new Headers({ Accept: "application/json" });
  headers.set("Authorization", "Basic " + apiKey);
  if (method === "POST") headers.set("Content-Type", "application/json");

  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetchImpl(baseUrl + endpoint, {
        method,
        headers,
        signal,
        ...(method === "POST" ? { body: JSON.stringify(tasks ?? []) } : {}),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error &&
        (cause.name === "TimeoutError" || cause.name === "AbortError");
      if (method === "POST") {
        throw new AmbiguousCallError(
          timedOut
            ? "DataForSEO request timed out after dispatch."
            : "DataForSEO request outcome is unknown after dispatch.",
          { cause },
        );
      }
      throw new AppError(
        503,
        "dataforseo_unavailable",
        "DataForSEO could not complete the free request.",
        { cause },
      )
    }

    if (response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        if (method === "POST") {
          throw new AmbiguousCallError("DataForSEO response could not be read after dispatch.", { cause });
        }
        throw new AppError(
          502,
          "dataforseo_bad_response",
          "DataForSEO returned an unreadable response.",
          { cause },
        );
      }
      if (text.length === 0) return null;
      try {
        return JSON.parse(text) as DataforseoResponseLike<T>;
      } catch (cause) {
        if (method === "POST") {
          throw new AmbiguousCallError("DataForSEO returned invalid JSON after dispatch.", { cause });
        }
        throw new AppError(
          502,
          "dataforseo_bad_response",
          "DataForSEO returned an invalid response.",
          { cause },
        );
      }
    }

    if (method === "GET" && response.status >= 500 && attempt < GET_RETRIES) {
      await new Promise((resolve) =>
        setTimeout(resolve, GET_RETRY_BACKOFF_MS * (attempt + 1)),
      );
      attempt += 1;
      continue;
    }

    const body = await readBody(response);
    const classified = options.classify?.(response.status, body, endpoint);
    if (classified) {
      throw classified;
    }
    throw failure(method, response.status);
  }
}

export function dataforseoPost<T extends DataforseoTaskLike = DataforseoTaskLike>(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<T> | null> {
  return request<T>("POST", path, tasks, options);
}

export function dataforseoGet<T extends DataforseoTaskLike = DataforseoTaskLike>(
  path: string,
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<T> | null> {
  return request<T>("GET", path, undefined, options);
}
