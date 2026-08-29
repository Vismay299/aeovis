import test from "node:test";
import assert from "node:assert/strict";
import {
  clamp,
  isFiniteNumber,
  roundTo,
  createLinearScale,
  niceCeil,
  buildTicks,
  pickTickIndices,
  buildLinePath,
  polarToCartesian,
  describeArcPath,
  buildDonutSegments,
  formatPercent,
  formatDelta,
  formatShortDate,
  dateTimeValue,
  collectTimeDomain,
  nearestPointIndex,
  findByDate,
  normalize,
  neutralRampVar,
  tealRampOpacity,
  computeMatrixDomain,
  barWidthPct,
  readableOnRamp,
} from "./chartMath.js";

// --- numeric basics ----------------------------------------------------

test("clamp bounds a value on both sides", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test("isFiniteNumber rejects non-numbers, NaN, Infinity, null", () => {
  assert.equal(isFiniteNumber(3.4), true);
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(NaN), false);
  assert.equal(isFiniteNumber(Infinity), false);
  assert.equal(isFiniteNumber(null), false);
  assert.equal(isFiniteNumber(undefined), false);
  assert.equal(isFiniteNumber("3"), false);
});

test("roundTo rounds to N decimals", () => {
  assert.equal(roundTo(3.456, 1), 3.5);
  assert.equal(roundTo(3.44, 1), 3.4);
  assert.equal(roundTo(3.456, 0), 3);
});

// --- scales --------------------------------------------------------------

test("createLinearScale maps domain to range linearly", () => {
  const scale = createLinearScale([0, 100], [0, 200]);
  assert.equal(scale(0), 0);
  assert.equal(scale(50), 100);
  assert.equal(scale(100), 200);
});

test("createLinearScale inverts range order fine (e.g. y-down SVG)", () => {
  const scale = createLinearScale([0, 100], [280, 0]);
  assert.equal(scale(0), 280);
  assert.equal(scale(100), 0);
  assert.equal(scale(50), 140);
});

test("createLinearScale on a zero-width domain returns the range midpoint", () => {
  const scale = createLinearScale([5, 5], [0, 200]);
  assert.equal(scale(5), 100);
});

test("createLinearScale returns range start for a non-finite input", () => {
  const scale = createLinearScale([0, 100], [10, 20]);
  assert.equal(scale(NaN), 10);
  assert.equal(scale(null), 10);
});

test("niceCeil rounds up to the next step", () => {
  assert.equal(niceCeil(3.4, 10), 10);
  assert.equal(niceCeil(10, 10), 10);
  assert.equal(niceCeil(10.1, 10), 20);
  assert.equal(niceCeil(0, 10), 10);
  assert.equal(niceCeil(-5, 10), 10);
});

test("buildTicks produces evenly spaced ticks including 0 and max", () => {
  assert.deepEqual(buildTicks(40, 5), [0, 10, 20, 30, 40]);
  assert.deepEqual(buildTicks(100, 5), [0, 25, 50, 75, 100]);
});

test("pickTickIndices returns every index when length fits under the cap", () => {
  assert.deepEqual(pickTickIndices(4, 6), [0, 1, 2, 3]);
});

test("pickTickIndices thins a long series and always keeps first/last", () => {
  const picked = pickTickIndices(30, 6);
  assert.equal(picked[0], 0);
  assert.equal(picked[picked.length - 1], 29);
  assert.ok(picked.length <= 6);
  // strictly increasing (de-duped)
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i] > picked[i - 1]);
});

test("pickTickIndices handles zero length", () => {
  assert.deepEqual(pickTickIndices(0, 6), []);
});

// --- SVG path building -----------------------------------------------------

test("buildLinePath draws one continuous subpath with no gaps", () => {
  const d = buildLinePath([{ x: 0, y: 10 }, { x: 10, y: 5 }, { x: 20, y: 8 }]);
  assert.equal(d, "M 0 10 L 10 5 L 20 8");
});

test("buildLinePath breaks into a new subpath at a null-y gap", () => {
  const d = buildLinePath([
    { x: 0, y: 10 },
    { x: 10, y: 5 },
    { x: 20, y: null },
    { x: 30, y: 8 },
    { x: 40, y: 9 },
  ]);
  assert.equal(d, "M 0 10 L 10 5 M 30 8 L 40 9");
});

test("buildLinePath emits a bare moveto for an isolated single point", () => {
  const d = buildLinePath([
    { x: 0, y: null },
    { x: 10, y: 5 },
    { x: 20, y: null },
  ]);
  assert.equal(d, "M 10 5");
});

test("buildLinePath on empty/absent input returns an empty string", () => {
  assert.equal(buildLinePath([]), "");
  assert.equal(buildLinePath(undefined), "");
});

test("polarToCartesian: 0deg is straight up from center", () => {
  const p = polarToCartesian(50, 50, 10, 0);
  assert.equal(roundTo(p.x, 5), 50);
  assert.equal(roundTo(p.y, 5), 40);
});

test("polarToCartesian: 90deg is straight right (clockwise from 12 o'clock)", () => {
  const p = polarToCartesian(50, 50, 10, 90);
  assert.equal(roundTo(p.x, 5), 60);
  assert.equal(roundTo(p.y, 5), 50);
});

test("polarToCartesian: 180deg is straight down, 270deg is straight left", () => {
  const down = polarToCartesian(50, 50, 10, 180);
  assert.equal(roundTo(down.x, 5), 50);
  assert.equal(roundTo(down.y, 5), 60);
  const left = polarToCartesian(50, 50, 10, 270);
  assert.equal(roundTo(left.x, 5), 40);
  assert.equal(roundTo(left.y, 5), 50);
});

test("describeArcPath starts/ends at the correct polar coordinates and picks the minor-arc flag", () => {
  const d = describeArcPath(50, 50, 10, 0, 90);
  const start = polarToCartesian(50, 50, 10, 0);
  const end = polarToCartesian(50, 50, 10, 90);
  assert.equal(d, `M ${start.x} ${start.y} A 10 10 0 0 1 ${end.x} ${end.y}`);
});

test("describeArcPath sets the large-arc-flag for sweeps over 180deg", () => {
  const d = describeArcPath(50, 50, 10, 0, 270);
  assert.match(d, /^M .* A 10 10 0 1 1 /);
});

test("describeArcPath uses sweep-flag 0 for a decreasing (counter-clockwise) angle", () => {
  const d = describeArcPath(50, 50, 10, 90, 0);
  assert.match(d, /^M .* A 10 10 0 0 0 /);
});

test("buildDonutSegments splits proportionally to value with no gap", () => {
  const segs = buildDonutSegments([{ name: "you", value: 70 }, { name: "rival", value: 30 }], { gapDeg: 0 });
  assert.equal(roundTo(segs[0].startAngle, 3), 0);
  assert.equal(roundTo(segs[0].endAngle, 3), 252); // 70% of 360
  assert.equal(roundTo(segs[1].startAngle, 3), 252);
  assert.equal(roundTo(segs[1].endAngle, 3), 360);
  assert.equal(roundTo(segs[0].pct, 3), 0.7);
});

test("buildDonutSegments reserves gapDeg between every pair of segments (n segments -> n gaps)", () => {
  const segs = buildDonutSegments([{ value: 1 }, { value: 1 }, { value: 1 }], { gapDeg: 3 });
  // available sweep = 360 - 3*3 = 351, split evenly into thirds = 117 each
  assert.equal(roundTo(segs[0].endAngle - segs[0].startAngle, 3), 117);
  assert.equal(roundTo(segs[1].startAngle - segs[0].endAngle, 3), 3);
});

test("buildDonutSegments treats a single segment as a full ring with no gap", () => {
  const segs = buildDonutSegments([{ value: 42 }], { gapDeg: 5 });
  assert.equal(segs[0].startAngle, 0);
  assert.equal(segs[0].endAngle, 360);
});

test("buildDonutSegments degenerates every segment to zero width when total is 0", () => {
  const segs = buildDonutSegments([{ value: 0 }, { value: null }], { gapDeg: 2 });
  assert.equal(segs[0].endAngle - segs[0].startAngle, 0);
  assert.equal(segs[1].endAngle - segs[1].startAngle, 0);
});

test("buildDonutSegments floors negative/non-finite values to 0 rather than throwing", () => {
  const segs = buildDonutSegments([{ value: -5 }, { value: 10 }], { gapDeg: 0 });
  assert.equal(segs[0].value, 0);
  assert.equal(segs[0].pct, 0);
  assert.equal(segs[1].pct, 1);
});

// --- formatting --------------------------------------------------------

test("formatPercent renders one decimal by default and an em dash for missing data", () => {
  assert.equal(formatPercent(6.666), "6.7%");
  assert.equal(formatPercent(0), "0.0%");
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(undefined), "—");
  assert.equal(formatPercent(NaN), "—");
});

test("formatDelta reports sign and an unsigned magnitude", () => {
  assert.deepEqual(formatDelta(3.44), { text: "3.4%", sign: "pos" });
  assert.deepEqual(formatDelta(-3.44), { text: "3.4%", sign: "neg" });
  assert.deepEqual(formatDelta(0), { text: "0.0%", sign: "zero" });
  assert.deepEqual(formatDelta(null), { text: "—", sign: "null" });
});

test("formatDelta treats a rounds-to-zero delta as zero, not a false pos/neg", () => {
  assert.deepEqual(formatDelta(-0.02, 1), { text: "0.0%", sign: "zero" });
});

test("formatShortDate reads the calendar date without any timezone shift", () => {
  assert.equal(formatShortDate("2026-06-01"), "JUN 1");
  assert.equal(formatShortDate("2026-01-31"), "JAN 31");
  assert.equal(formatShortDate(""), "");
  assert.equal(formatShortDate(null), "");
});

test("dateTimeValue treats a bare date as UTC midnight", () => {
  assert.equal(dateTimeValue("2026-01-01"), Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(dateTimeValue(""), null);
  assert.equal(dateTimeValue("not-a-date"), null);
});

test("collectTimeDomain spans every series and pads a single-timestamp domain", () => {
  const domain = collectTimeDomain([
    [{ date: "2026-01-01" }, { date: "2026-01-05" }],
    [{ date: "2026-01-03" }],
  ]);
  assert.equal(domain.min, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(domain.max, Date.parse("2026-01-05T00:00:00Z"));

  const single = collectTimeDomain([[{ date: "2026-01-01" }]]);
  assert.ok(single.max > single.min);
});

test("collectTimeDomain on no valid dates falls back to a safe non-zero span", () => {
  const domain = collectTimeDomain([[{ date: null }], []]);
  assert.ok(domain.max > domain.min);
});

// --- hover helpers -------------------------------------------------------

test("nearestPointIndex finds the closest x", () => {
  assert.equal(nearestPointIndex([0, 10, 20, 30], 22), 2);
  assert.equal(nearestPointIndex([0, 10, 20, 30], -5), 0);
  assert.equal(nearestPointIndex([0, 10, 20, 30], 100), 3);
  assert.equal(nearestPointIndex([], 5), -1);
});

test("findByDate matches on exact date string, else null", () => {
  const series = [{ date: "2026-01-01", visibility_pct: 5 }, { date: "2026-01-02", visibility_pct: 6 }];
  assert.equal(findByDate(series, "2026-01-02").visibility_pct, 6);
  assert.equal(findByDate(series, "2026-01-09"), null);
  assert.equal(findByDate(undefined, "2026-01-02"), null);
});

// --- color ramps -----------------------------------------------------------

test("normalize maps a value into 0..1 against a domain", () => {
  assert.equal(normalize(50, 0, 100), 0.5);
  assert.equal(normalize(0, 0, 100), 0);
  assert.equal(normalize(100, 0, 100), 1);
  assert.equal(normalize(-10, 0, 100), 0); // clamped
  assert.equal(normalize(200, 0, 100), 1); // clamped
});

test("normalize on an equal min/max domain reads as fully-colored for any positive value", () => {
  assert.equal(normalize(5, 5, 5), 1);
  assert.equal(normalize(0, 0, 0), 0);
});

test("normalize returns null for non-finite input (renders as an empty cell, not a ramp step)", () => {
  assert.equal(normalize(null, 0, 100), null);
  assert.equal(normalize(undefined, 0, 100), null);
});

test("neutralRampVar returns a var() reference from the neutral token ramp at both ends and mid-scale", () => {
  // Token names updated for the Results Night steel ramp (NEUTRAL_RAMP_TOKENS
  // in chartMath.js). This assertion still named the pre-redesign
  // --bg-2/--border-3/--text-2 tokens and had been failing since the design
  // system was ported — invisibly, because the package.json test glob did not
  // reach src/components. Fixed alongside the glob in R0.4.3.
  assert.equal(neutralRampVar(0), "var(--steel-1)");
  assert.equal(neutralRampVar(1), "var(--nickel)");
  assert.equal(neutralRampVar(0.5), "var(--steel-4)");
});

test("neutralRampVar never returns a teal or rival token regardless of input", () => {
  for (const t of [-1, 0, 0.1, 0.33, 0.5, 0.75, 0.99, 1, 2, null]) {
    const result = neutralRampVar(t);
    assert.ok(!result.includes("--you"));
    assert.ok(!result.includes("--rival"));
    assert.ok(!result.includes("--accent"));
  }
});

test("tealRampOpacity is monotonic and bounded to [min, max]", () => {
  assert.equal(tealRampOpacity(0), 0.16);
  assert.equal(tealRampOpacity(1), 1);
  assert.equal(tealRampOpacity(0.5), 0.58);
  assert.equal(tealRampOpacity(-1), 0.16); // clamped
  assert.equal(tealRampOpacity(2), 1); // clamped
});

test("computeMatrixDomain finds min/max across a brand x engine matrix, ignoring nulls", () => {
  const domain = computeMatrixDomain({
    "snitch.com": { aio: 6.7, perplexity: 4.2 },
    "rival-a.com": { aio: 12.1, perplexity: null },
  });
  assert.equal(domain.min, 4.2);
  assert.equal(domain.max, 12.1);
});

test("computeMatrixDomain falls back to a 0..100 percent domain when nothing is finite", () => {
  assert.deepEqual(computeMatrixDomain({}), { min: 0, max: 100 });
  assert.deepEqual(computeMatrixDomain({ a: { x: null } }), { min: 0, max: 100 });
});

test("readableOnRamp flips past its threshold in both directions", () => {
  assert.equal(readableOnRamp(0), false);
  assert.equal(readableOnRamp(0.61), false);
  assert.equal(readableOnRamp(0.62), true);
  assert.equal(readableOnRamp(1), true);
  assert.equal(readableOnRamp(null), false);
});

test("barWidthPct scales relative to the row max and floors tiny values to a visible stub", () => {
  assert.equal(barWidthPct(50, 100), 50);
  assert.equal(barWidthPct(100, 100), 100);
  assert.equal(barWidthPct(0.01, 100), 2); // floored to min
  assert.equal(barWidthPct(0, 100), 2);
  assert.equal(barWidthPct(50, 0), 2); // no valid max
  assert.equal(barWidthPct(null, 100), 2);
});
