// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/IssuesView.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — one line of issue details, phrased for its issue type.

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value) return [value];
  return [];
}

export function formatIssueDetails(
  issueType: string,
  details: Record<string, unknown> | null | undefined,
): string | null {
  if (!details) return null;

  if (issueType === "broken-internal-link" || issueType === "broken-page") {
    if (typeof details.targetUrl !== "string") return null;
    const status =
      details.targetStatus != null ? ` (${details.targetStatus})` : "";
    return `Links to ${details.targetUrl}${status}`;
  }

  if (issueType.endsWith("crawler-blocked")) {
    const bots = asList(details.bots);
    return bots.length ? `Blocked for: ${bots.join(", ")}` : null;
  }

  if (issueType.startsWith("duplicate-")) {
    const others = asList(details.otherUrls);
    return others.length ? `Same as: ${others.join(", ")}` : null;
  }

  if (issueType === "redirect-chain" || issueType === "redirect-loop") {
    const hops = asList(details.hops);
    return hops.length ? `Hops: ${hops.join(" → ")}` : null;
  }

  if (issueType === "structured-data-missing-required") {
    const items = Array.isArray(details.items)
      ? (details.items as Array<{ type?: string; missing?: unknown }>)
      : [];
    if (!items.length) return null;
    return items
      .map(
        (item) =>
          `Missing on ${item.type ?? "object"}: ${asList(item.missing).join(", ")}`,
      )
      .join("; ");
  }

  if (issueType === "structured-data-not-visible") {
    const claims = Array.isArray(details.claims)
      ? (details.claims as Array<{ path?: string; value?: unknown }>)
      : [];
    if (!claims.length) return null;
    return `Not on the page: ${claims
      .map((claim) => `${claim.path ?? "value"} = ${String(claim.value)}`)
      .join(", ")}`;
  }

  if (issueType === "hreflang-invalid") {
    const entries = Array.isArray(details.entries)
      ? (details.entries as Array<{ lang?: string; href?: unknown }>)
      : [];
    if (!entries.length) return null;
    return `Invalid: ${entries
      .map((entry) => `${entry.lang ?? "?"} → ${String(entry.href ?? "no href")}`)
      .join(", ")}`;
  }

  if (issueType === "hreflang-no-return-link") {
    return typeof details.alternate === "string"
      ? `Alternate: ${details.alternate}`
      : null;
  }

  if (issueType === "snippet-restricted") {
    const sources = asList(details.sources);
    return sources.length ? `Restricted by: ${sources.join(", ")}` : null;
  }

  if (issueType === "missing-og-tags") {
    const missing = asList(details.missing);
    return missing.length ? `Missing: ${missing.join(", ")}` : null;
  }

  const parts = Object.entries(details)
    .filter(([, value]) => value != null && typeof value !== "object")
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length ? parts.join(" · ") : null;
}

export function IssueDetails({
  issueType,
  details,
}: {
  issueType: string;
  details: Record<string, unknown> | null | undefined;
}) {
  const text = formatIssueDetails(issueType, details);
  if (!text) return null;
  return <p className="text-xs text-muted-foreground">{text}</p>;
}
