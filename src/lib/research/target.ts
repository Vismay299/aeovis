// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/domainUtils.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { getDomain } from "tldts";
import { AppError } from "../http/appError.ts";
import {
  isValidDomainHost,
  parseResearchTarget,
  type ResearchScope,
  type ResearchTarget,
} from "../../shared/researchScope.ts";

export function parseResearchTargetOrThrow(
  input: string,
  scope?: ResearchScope,
): ResearchTarget {
  const parsed = parseResearchTarget(input, scope);
  if (!parsed.ok) {
    throw new AppError(400, "invalid_target", parsed.message);
  }
  return parsed.target;
}

export function toRelativePath(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return null;
  }
}

export function normalizeDomainInput(
  input: string,
  includeSubdomains: boolean,
): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    throw new AppError(400, "invalid_target", "Domain is required");
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let host: string;
  try {
    host = new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    throw new AppError(400, "invalid_target", "Domain is invalid");
  }

  if (!host) {
    throw new AppError(400, "invalid_target", "Domain is invalid");
  }

  // Reject fake TLDs / non-registrable hosts (e.g. "example.por") before they
  // reach DataForSEO and come back as an opaque "Invalid Field: 'target'".
  if (!isValidDomainHost(host)) {
    throw new AppError(
      400,
      "invalid_target",
      "Enter a valid domain like example.com",
    );
  }

  if (includeSubdomains) {
    return host;
  }

  return getDomain(host) ?? host;
}
