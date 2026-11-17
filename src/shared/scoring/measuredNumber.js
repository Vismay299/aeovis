/**
 * R2.9.7 — the one place the scoring layer is allowed to turn "maybe a number"
 * into a number, and the one place it is allowed to divide.
 *
 * WHY THIS MODULE EXISTS. One defect class has been caught seven separate times
 * across this rebuild (R2.1.2, R2.7.12, R2.2.7, R2.8.16, R2.7.13, R2.7.16,
 * R2.9.6): a value meaning "not measured" silently becoming `0`. R2.7.16 proved
 * the structural lesson — the coercion is almost never in the component that
 * prints the number. `DashboardShell.jsx:1004` already guarded `error_rate_pct`
 * with `== null || !Number.isFinite(...)` and it STILL rendered `0%`, because
 * `describeDegradedSlice` in enginePipeline.js had done `Number(slice.error_rate_pct)`
 * two layers earlier and `Number(null) === 0` while `Number.isFinite(0) === true`.
 * Once that has happened a fabricated zero and a measured zero are literally the
 * same value and NO downstream guard can separate them again.
 *
 * So the coercion belongs here, at the layer that PRODUCES metric objects, and
 * nowhere else. `measuredNumberOrNull` was introduced by R2.7.16 inside
 * enginePipeline.js; R2.9.7 moved it out so contentLift.js (and the next
 * producer) share one implementation rather than hand-rolling the shape per
 * site. src/shared/scoring/metricCoercionGuard.test.mjs is the walker that keeps
 * it that way.
 *
 * BOTH SIDES, ALWAYS. A genuinely measured `0` must survive as `0`. An
 * over-eager fix that blanks real zeros into em dashes is exactly as dishonest
 * as the fabrication it replaced, and every function here is tested from both
 * directions.
 */

/**
 * A metric the record never carried must not read as a measured zero.
 *
 * Returns the finite number, or null for null/undefined/""/non-numeric input.
 * A real `0` still returns `0`.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function measuredNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A percentage that only exists if something was divided.
 *
 * `denominator > 0 ? ratio : 0` is the same lie as `Number(null)` wearing a
 * different construct, and it is the form the sweep found most often in
 * summarizeEngineSlice: a slice that asked no non-branded prompts published
 * `coverage_pct: 0` — "we answered none of the ones we asked" — when nothing was
 * asked at all. An empty denominator means there is no reading; the caller's
 * state/state_reason pair is what explains which kind of nothing it was.
 *
 * A non-empty denominator with a zero numerator still returns `0`. "We looked at
 * 30 answers and you were in none of them" is a real, hard-won finding and must
 * not be blanked.
 *
 * @param {unknown} numerator
 * @param {unknown} denominator
 * @param {object}  [options]
 * @param {number}  [options.decimals=1]  digits kept after the decimal point.
 * @returns {number|null}
 */
export function ratioPctOrNull(numerator, denominator, { decimals = 1 } = {}) {
  const den = measuredNumberOrNull(denominator);
  const num = measuredNumberOrNull(numerator);
  if (den === null || den <= 0) return null;
  if (num === null) return null;
  const factor = 10 ** decimals;
  return Math.round((num / den) * 100 * factor) / factor;
}
