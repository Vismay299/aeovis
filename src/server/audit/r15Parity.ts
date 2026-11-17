// R15 → F18 parity map (F18 §6.2.11).
// Maps each R15 issue code from src/server/repairs/technicalAudit.js to the
// F18 audit issue type(s) that must appear for the same page.

import type { AuditIssueType } from "../../shared/audit-issues.ts";

export const R15_TO_F18 = {
  access_denied: ["blocked-page"],
  http_status: ["broken-page", "server-error"],
  restrictive_directive: ["noindex-page", "snippet-restricted"],
  data_nosnippet: ["snippet-restricted"],
  canonical_other_url: ["canonicalized-page"],
  insufficient_source_text: ["thin-content"],
  structured_data_requires_review: [
    "structured-data-invalid",
    "structured-data-not-visible",
  ],
} as const satisfies Record<string, readonly AuditIssueType[]>;

export type R15IssueCode = keyof typeof R15_TO_F18;

/**
 * Expected F18 types for one R15 issue, honouring the conditional rows of
 * §6.2.11. Callers pass the R15 issue's code plus the detail needed to pick
 * the branch:
 * - http_status: pass `status` (4xx → broken-page, 5xx → server-error).
 * - restrictive_directive: pass the directive `value` string
 *   (`noindex`/`none` → noindex-page, `nosnippet`/`max-snippet:0` → snippet-restricted).
 * - structured_data_requires_review: pass `kind` (`invalid` → structured-data-invalid,
 *   `not-visible` → structured-data-not-visible).
 * Other codes return the full mapped list.
 */
export function expectedF18ForR15(
  code: string,
  detail?: { status?: number; value?: string; kind?: string },
): AuditIssueType[] {
  if (code === "http_status") {
    const status = detail?.status ?? 0;
    if (status >= 500) return ["server-error"];
    return ["broken-page"];
  }
  if (code === "restrictive_directive") {
    const value = String(detail?.value ?? "").toLowerCase();
    const wantsNoindex = /\b(noindex|none)\b/.test(value);
    const wantsSnippet = /\b(nosnippet|max-snippet\s*:\s*0)\b/.test(value);
    if (wantsNoindex && wantsSnippet) return ["noindex-page", "snippet-restricted"];
    if (wantsNoindex) return ["noindex-page"];
    if (wantsSnippet) return ["snippet-restricted"];
    return [...R15_TO_F18.restrictive_directive];
  }
  if (code === "structured_data_requires_review") {
    if (detail?.kind === "invalid") return ["structured-data-invalid"];
    if (detail?.kind === "not-visible") return ["structured-data-not-visible"];
    return [...R15_TO_F18.structured_data_requires_review];
  }
  const mapped = (R15_TO_F18 as Record<string, readonly AuditIssueType[]>)[code];
  return mapped ? [...mapped] : [];
}
