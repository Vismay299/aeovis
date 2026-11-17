// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/domainUtils.ts
// Key-page normalization copied from src/server/features/project-context/services/contextUpdateOps.ts.
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { isIP } from "node:net";
import { AppError } from "../../shared/http/appError.ts";

function invalidWebsite(raw: string): AppError {
  return new AppError(400, "context_invalid", `Not a valid website: ${raw}`);
}

export function normalizeCompetitorDomain(raw: string): string {
  const input = raw.trim().toLowerCase();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalidWebsite(raw);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^\[|\]$/g, "");
  if (!host.includes(".") || isIP(host) !== 0) throw invalidWebsite(raw);
  return host;
}

export function normalizeKeyPageUrl(raw: string): string {
  const input = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new AppError(400, "context_invalid", `Not a valid page URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError(400, "context_invalid", `Not a valid page URL: ${raw}`);
  }
  url.protocol = "https:";
  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./, "");
  const href = url.toString();
  return url.pathname === "/" && !url.search ? href.replace(/\/$/, "") : href;
}

export function normalizeResearchKey(raw: string): string {
  const normalized = raw.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized.length > 300) {
    throw new AppError(400, "context_invalid", "Research keys are capped at 300 characters.");
  }
  return normalized;
}
