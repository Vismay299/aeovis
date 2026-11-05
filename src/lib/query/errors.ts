// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/error-messages.ts
//   src/client/lib/error-messages.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
//
// F05 §6.2 — error helpers and the spend-refusal view. Our routes send human
// messages, so the message wins; the code drives the spend card.

import { isApiError, type ApiError } from "./fetchJson.ts";

export const SPEND_REFUSAL_CODES = [
  "feature_disabled",
  "daily_cap",
  "workspace_cap",
  "over_approved_max",
] as const;

export type SpendRefusalCode = (typeof SPEND_REFUSAL_CODES)[number];

const DEFAULT_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function isSpendRefused(
  e: unknown,
): e is ApiError & { code: SpendRefusalCode } {
  return (
    isApiError(e) && (SPEND_REFUSAL_CODES as readonly string[]).includes(e.code)
  );
}

/**
 * ApiError -> its message; Error with a message -> message; anything else
 * (including thrown strings) -> `fallback`.
 */
export function describeError(e: unknown, fallback?: string): string {
  if (isApiError(e) && e.message) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback ?? DEFAULT_ERROR_MESSAGE;
}

const SPEND_TITLES: Record<
  SpendRefusalCode,
  { title: string; showUsageLink: boolean }
> = {
  feature_disabled: {
    title: "Not available for this workspace",
    showUsageLink: false,
  },
  daily_cap: { title: "Daily spend limit reached", showUsageLink: true },
  workspace_cap: { title: "Monthly spend limit reached", showUsageLink: true },
  over_approved_max: { title: "The price changed", showUsageLink: false },
};

export function spendRefusedView(e: ApiError & { code: SpendRefusalCode }): {
  title: string;
  message: string;
  recovery: string | null;
  showUsageLink: boolean;
} {
  const row = SPEND_TITLES[e.code];
  return {
    title: row.title,
    message: e.message,
    recovery: e.recovery ?? null,
    showUsageLink: row.showUsageLink,
  };
}
