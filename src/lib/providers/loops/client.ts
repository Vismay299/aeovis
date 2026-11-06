// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/email/loops-client.ts, src/server/email/loops.ts, src/server/billing/loops-sync.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";

export const LOOPS_BASE_URL = "https://app.loops.so/api/v1";

export type LoopsErrorCode = "timeout" | "network" | "rate_limited" | "server" | "rejected";

export class LoopsError extends Error {
  status: number;
  code: LoopsErrorCode;

  constructor(status: number, code: LoopsErrorCode, message?: string) {
    super(message ?? `Loops request failed (${status}: ${code})`);
    this.name = "LoopsError";
    this.status = status;
    this.code = code;
  }
}

export type LoopsDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type LoopsContactPayload = {
  email: string;
  userId: string;
  firstName?: string;
  lastName?: string;
  source?: string;
  subscribed?: boolean;
  userGroup?: string;
  mailingLists?: Record<string, boolean>;
} & Record<string, string | number | boolean | undefined | Record<string, boolean>>;

async function performLoopsRequest(
  endpoint: string,
  method: "PUT" | "POST",
  apiKey: string,
  body: unknown,
  idempotencyKey?: string,
  deps?: LoopsDeps,
): Promise<{ status: number; duplicate: boolean }> {
  const fetchFn = deps?.fetch ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? 10_000;
  const url = `${LOOPS_BASE_URL}/${endpoint}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    const code: LoopsErrorCode = isTimeout ? "timeout" : "network";
    console.warn("[loops] request failed", { endpoint, status: 0, code });
    throw new LoopsError(0, code, `Failed to reach Loops (${code})`);
  }

  if (response.ok) {
    return { status: response.status, duplicate: false };
  }

  if (response.status === 409) {
    return { status: 409, duplicate: true };
  }

  let code: LoopsErrorCode;
  if (response.status === 429) {
    code = "rate_limited";
  } else if (response.status >= 500 && response.status <= 599) {
    code = "server";
  } else {
    code = "rejected";
  }

  console.warn("[loops] request failed", { endpoint, status: response.status, code });
  throw new LoopsError(response.status, code, `Loops request rejected with status ${response.status}`);
}

export async function updateLoopsContact(
  i: { apiKey: string; payload: LoopsContactPayload },
  deps?: LoopsDeps,
): Promise<void> {
  await performLoopsRequest("contacts/update", "PUT", i.apiKey, i.payload, undefined, deps);
}

export async function sendLoopsEvent(
  i: {
    apiKey: string;
    payload: {
      email: string;
      userId: string;
      eventName: string;
      eventProperties?: Record<string, string | number | boolean>;
    };
    idempotencyKey: string;
  },
  deps?: LoopsDeps,
): Promise<{ duplicate: boolean }> {
  const result = await performLoopsRequest(
    "events/send",
    "POST",
    i.apiKey,
    i.payload,
    i.idempotencyKey,
    deps,
  );
  return { duplicate: result.duplicate };
}

export async function sendLoopsTransactional(
  i: {
    apiKey: string;
    transactionalId: string;
    email: string;
    dataVariables: Record<string, string>;
    idempotencyKey: string;
  },
  deps?: LoopsDeps,
): Promise<{ duplicate: boolean }> {
  const body = {
    transactionalId: i.transactionalId,
    email: i.email,
    addToAudience: false,
    dataVariables: i.dataVariables,
  };
  const result = await performLoopsRequest(
    "transactional",
    "POST",
    i.apiKey,
    body,
    i.idempotencyKey,
    deps,
  );
  return { duplicate: result.duplicate };
}

export function getContactNameParts(name: string | null | undefined): { firstName?: string; lastName?: string } {
  const trimmedName = name?.trim();
  if (!trimmedName) {
    return {};
  }
  const [firstName, ...lastNameParts] = trimmedName.split(/\s+/);
  const lastName = lastNameParts.join(" ");
  return {
    firstName,
    ...(lastName ? { lastName } : {}),
  };
}

export function loopsIdempotencyKey(raw: string): string {
  if (raw.length <= 100) {
    return raw;
  }
  return "h:" + createHash("sha256").update(raw).digest("hex").slice(0, 64);
}
