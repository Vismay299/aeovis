/**
 * Pure, dependency-free chart math for the Perceev "Results Night" chart
 * library (src/components/perceev/charts/*). Kept separate from the React
 * components so it's unit-testable with `node --test` (see
 * chartMath.test.mjs) without a DOM/JSX transform — mirrors the
 * src/shared/brandAnalyticsApi.js convention of pulling pure helpers out of
 * their consumers.
 *
 * Nothing in this file touches color VALUES — ramp helpers return
 * `var(--token)` strings or a 0..1 opacity number for the caller to apply to
 * a token-colored element. That's what keeps the components' "never
 * hardcode a hex" rule enforceable: the math lives here, the tokens live in
 * globals.css, and the two only ever meet as `var(--token)` strings.
 */

// ---------------------------------------------------------------------------
// Numeric basics
// ---------------------------------------------------------------------------

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function roundTo(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/**
 * Linear scale factory: createLinearScale([d0, d1], [r0, r1]) returns a
 * function mapping a domain value to the range. Degenerate (zero-width)
 * domains map every value to the range midpoint rather than dividing by
 * zero.
 */
export function createLinearScale([d0, d1], [r0, r1]) {
  const span = d1 - d0;
  return (value) => {
    if (!isFiniteNumber(value)) return r0;
    if (span === 0) return (r0 + r1) / 2;
    const t = (value - d0) / span;
    return r0 + t * (r1 - r0);
  };
}

/** Rounds up to the next multiple of `step` (min one step) — a friendly y-axis ceiling. */
export function niceCeil(value, step = 10) {
  const v = isFiniteNumber(value) ? value : 0;
  if (v <= 0) return step;
  return Math.ceil(v / step) * step;
}

/** `count` evenly spaced ticks from 0 to `max` inclusive. */
export function buildTicks(max, count = 5) {
  const n = Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => roundTo((max * i) / n, 0));
}

/**
 * Evenly-spaced indices into a `length`-long array, capped at `maxTicks`,
 * always including the first and last index. Used to thin x-axis date
 * labels so they never collide on a long series.
 */
export function pickTickIndices(length, maxTicks = 6) {
  if (length <= 0) return [];
  if (length <= maxTicks) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (maxTicks - 1);
  const picked = [];
  for (let i = 0; i < maxTicks; i++) {
    picked.push(Math.round(i * step));
  }
  return [...new Set(picked)];
}

// ---------------------------------------------------------------------------
// SVG path building
// ---------------------------------------------------------------------------

/**
 * Builds a (possibly multi-subpath) SVG line `d` string from already-scaled
 * `{x, y}` points. A point with `y == null` (a missing metric day) breaks
 * the line into a new subpath rather than interpolating across the gap or
 * drawing down to zero — a broadcast tally never implies data it doesn't
 * have. A run of exactly one point emits a bare "M x,y" (no "L") so callers
 * can still place a dot there.
 */
export function buildLinePath(points) {
  if (!Array.isArray(points) || points.length === 0) return "";

  const runs = [];
  let current = [];
  for (const p of points) {
    const usable = p && isFiniteNumber(p.x) && isFiniteNumber(p.y);
    if (!usable) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    current.push(p);
  }
  if (current.length) runs.push(current);

  return runs
    .map((run) => {
      const [first, ...rest] = run;
      const move = `M ${first.x} ${first.y}`;
      if (rest.length === 0) return move;
      return `${move} ${rest.map((p) => `L ${p.x} ${p.y}`).join(" ")}`;
    })
    .join(" ");
}

/** angleDeg: 0 = 12 o'clock, increasing = clockwise (standard donut convention). */
export function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * A single stroked arc (not a filled pie wedge — no lines back to center),
 * meant to be drawn with `fill="none"` and a `strokeWidth` for a donut ring
 * segment. Sweeps clockwise from startAngle to endAngle (SVG sweep-flag=1 is
 * the clockwise direction given the y-down coordinate system, which matches
 * our polarToCartesian's "increasing angle = clockwise" convention).
 */
export function describeArcPath(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const sweep = endAngle - startAngle;
  const largeArcFlag = Math.abs(sweep) > 180 ? 1 : 0;
  const sweepFlag = sweep >= 0 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;
}

/**
 * Lays out donut ring segments proportional to `value`, each separated by a
 * `gapDeg` hairline of empty arc (skipped when there's only one segment).
 * Non-finite/negative values are treated as 0. When every value is 0 (or
 * the list is empty), every segment gets a zero-width arc — the Donut
 * component renders a faint full-ring "no data" fallback in that case
 * rather than this helper inventing a value.
 */
export function buildDonutSegments(segments, { gapDeg = 1.5 } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const n = list.length;
  const values = list.map((s) => (isFiniteNumber(s?.value) && s.value > 0 ? s.value : 0));
  const total = values.reduce((a, b) => a + b, 0);
  const gapTotal = n > 1 ? gapDeg * n : 0;
  const sweepAvailable = Math.max(0, 360 - gapTotal);

  let cursor = 0;
  return list.map((seg, i) => {
    const value = values[i];
    const pct = total > 0 ? value / total : 0;
    const sweep = total > 0 ? pct * sweepAvailable : 0;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    cursor = endAngle + (n > 1 ? gapDeg : 0);
    return { ...seg, value, pct, startAngle, endAngle };
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPercent(value, decimals = 1) {
  if (!isFiniteNumber(value)) return "—"; // em dash
  return `${roundTo(value, decimals).toFixed(decimals)}%`;
}

/**
 * Returns `{ text, sign }` for a delta value. `sign` drives DeltaChip's
 * color/triangle: "pos" | "neg" | "zero" | "null". `text` is the unsigned
 * magnitude (the triangle already encodes direction — a redundant "+"/"-"
 * would just be noise on a compact chip).
 */
export function formatDelta(value, decimals = 1) {
  if (!isFiniteNumber(value)) return { text: "—", sign: "null" };
  const rounded = roundTo(value, decimals);
  const sign = rounded === 0 ? "zero" : rounded > 0 ? "pos" : "neg";
  return { text: `${Math.abs(rounded).toFixed(decimals)}%`, sign };
}

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * "2026-06-01" -> "JUN 1". Parses the ISO date string directly (no `Date`
 * object) so it can never shift a day under a negative UTC offset — the
 * classic `new Date("2026-06-01").getDate()` timezone bug.
 */
export function formatShortDate(dateStr) {
  if (!dateStr) return "";
  const parts = String(dateStr).slice(0, 10).split("-");
  if (parts.length !== 3) return String(dateStr);
  const [, m, d] = parts;
  const month = MONTH_ABBR[parseInt(m, 10) - 1] || m;
  return `${month} ${parseInt(d, 10)}`;
}

/**
 * Epoch-ms for an ISO date/datetime string, forced to UTC when given a bare
 * "YYYY-MM-DD" (matching brand_metrics_daily's UTC calendar date — see
 * the /metrics route's parseDateParam comment). Returns null for anything
 * unparseable so callers can skip it rather than plot `NaN`.
 */
export function dateTimeValue(dateStr) {
  if (!dateStr) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `${dateStr}T00:00:00Z` : dateStr;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Min/max epoch-ms across every `{date}` point in a list of series (self +
 * every compare series) — the shared x-domain for a multi-line trend chart.
 * A single distinct timestamp gets padded by 1ms so the resulting scale
 * still has a non-zero span.
 */
export function collectTimeDomain(seriesList) {
  let min = Infinity;
  let max = -Infinity;
  for (const series of seriesList || []) {
    for (const point of series || []) {
      const t = dateTimeValue(point?.date);
      if (t == null) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

// ---------------------------------------------------------------------------
// Hover helpers
// ---------------------------------------------------------------------------

/** Index of the entry in `xs` closest to `targetX`. Returns -1 for an empty array. */
export function nearestPointIndex(xs, targetX) {
  if (!Array.isArray(xs) || xs.length === 0) return -1;
  let best = 0;
  let bestDist = Math.abs(xs[0] - targetX);
  for (let i = 1; i < xs.length; i++) {
    const dist = Math.abs(xs[i] - targetX);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** First point in `series` whose `date` exactly matches `dateStr`, or null. */
export function findByDate(series, dateStr) {
  if (!Array.isArray(series)) return null;
  return series.find((d) => d && d.date === dateStr) ?? null;
}

// ---------------------------------------------------------------------------
// Color ramps — role-vs-magnitude enforcement
//
// DESIGN.md: "Teal and red never mark anything except you/rivals+trailing."
// A magnitude heatmap can't use red-intensity for rivals without turning
// every mid-scoring competitor into a false alarm, so PerformanceMatrix (and
// anything else ranking rivals by magnitude) uses this NEUTRAL ramp for
// every rival, and reserves the TEAL ramp for the self row only.
// ---------------------------------------------------------------------------

/** 0..1, clamped; equal min/max reads as "fully colored" (nothing to rank) rather than a divide-by-zero. */
export function normalize(value, min, max) {
  if (!isFiniteNumber(value)) return null;
  if (max === min) return value > 0 ? 1 : 0;
  return clamp((value - min) / (max - min), 0, 1);
}

/** Dark -> light steel steps. A rival's magnitude is a quantity, never a role
    colour: only your own series is allowed to ramp toward bone. */
export const NEUTRAL_RAMP_TOKENS = ["--steel-1", "--steel-2", "--steel-3", "--steel-4", "--steel-5", "--nickel"];

export function neutralRampVar(t) {
  const clamped = clamp(t ?? 0, 0, 1);
  const idx = Math.min(NEUTRAL_RAMP_TOKENS.length - 1, Math.floor(clamped * NEUTRAL_RAMP_TOKENS.length));
  return `var(${NEUTRAL_RAMP_TOKENS[idx]})`;
}

/** Opacity (not hue) for the self-row teal ramp: faint at t=0, solid `--you` at t=1. */
export function tealRampOpacity(t, { min = 0.16, max = 1 } = {}) {
  const clamped = clamp(t ?? 0, 0, 1);
  return roundTo(min + clamped * (max - min), 2);
}

/** Min/max across every finite value in a {[brand]: {[engine]: pct}} matrix. Falls back to a 0..100 percent domain when nothing is finite. */
export function computeMatrixDomain(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const engineMap of Object.values(values || {})) {
    for (const v of Object.values(engineMap || {})) {
      if (isFiniteNumber(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 100 };
  return { min, max };
}

/**
 * Both PerformanceMatrix ramps (neutral graphite AND teal-opacity) run from
 * a dark low end to a bright high end, so a cell's value text needs to flip
 * from light to dark past some intensity or it goes illegible against its
 * own fill (the classic heatmap-with-labels problem). One threshold serves
 * both ramps closely enough — see PerformanceMatrix.jsx for which token
 * each side flips to.
 */
export function readableOnRamp(t, threshold = 0.62) {
  return (t ?? 0) >= threshold;
}

/** RankTable bar width as a % of the row with the largest value, floored so small-but-real values still show a visible stub. */
export function barWidthPct(value, maxValue, { min = 2 } = {}) {
  if (!isFiniteNumber(value) || value <= 0) return min;
  if (!isFiniteNumber(maxValue) || maxValue <= 0) return min;
  const pct = clamp((value / maxValue) * 100, 0, 100);
  return Math.max(min, roundTo(pct, 1));
}
