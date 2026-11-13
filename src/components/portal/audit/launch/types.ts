// F18 phase 4 — launch-form helpers.

import {
  DEFAULT_AUDIT_PAGES,
  MIN_AUDIT_PAGES,
} from "@/shared/audit-limits";

/**
 * A max-pages input's value committed on blur: digits only, clamped to the
 * allowed range. An empty or non-numeric value falls back to the default.
 */
export function clampMaxPagesInput(
  raw: string,
  max: number,
  fallback = DEFAULT_AUDIT_PAGES,
): number {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return Math.min(Math.max(fallback, MIN_AUDIT_PAGES), max);
  const value = Number(digits);
  if (!Number.isFinite(value)) return Math.min(Math.max(fallback, MIN_AUDIT_PAGES), max);
  return Math.min(Math.max(value, MIN_AUDIT_PAGES), max);
}
