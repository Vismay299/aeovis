import { extractBrandDomain } from "./citations.js";

/**
 * Canonical identity key for a brand's tracked prompt set.
 *
 * Product contract (2026-07-20): prompt sets are keyed by DOMAIN, not the
 * typed brand name — "Sleepy Owl", "sleepy owl coffee", and "SLEEPY OWL"
 * must all resolve to the same tracked set. The domain is what users type
 * consistently; the brand name is display-only.
 *
 * Falls back to the normalized brand name only when no usable URL was given
 * (the scan form requires a website, so this is rare — legacy rows and tests).
 */
export function resolveBrandKey(brand, url) {
  const domain = extractBrandDomain(url || "");
  if (domain) return domain;
  return String(brand || "").trim().toLowerCase();
}
