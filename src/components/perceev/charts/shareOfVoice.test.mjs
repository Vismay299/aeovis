import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShareOfVoice, SHARE_STATE, NOT_AVAILABLE_LABEL } from "./shareOfVoice.js";
import { ROSTER_SOURCE } from "../../../lib/scoring/rosterContinuity.js";

/**
 * R2.7.1 / finding A8 — the Share of Voice donut must read the pipeline's
 * `share_of_voice_pct` and never rebuild a share out of visibility numbers.
 *
 * Two halves, for the same reason chartMath.test.mjs exists: `node --test` has
 * no JSX transform, so the DECISION lives in shareOfVoice.js and is unit-tested
 * directly here, and a source walker at the bottom proves the two .jsx files
 * actually consult it rather than keeping a copy of the arithmetic.
 *
 * THE BUG THIS PINS. RankAndSharePanel handed the rank board's `rankedEntries`
 * (self + rivals keyed by VISIBILITY score) to <Donut segments={...}>, which
 * did `selfSeg.value / sum(values) * 100`. With one entry — self alone, which
 * is every scan where no rival was discovered or none was scored yet — that is
 * 1, and the panel printed "100.0% share". `legacySelfPct` below is that exact
 * expression, kept as a live witness: it still returns 100 for the fixture, and
 * the resolver returns null for the same input.
 */

/** The pre-R2.7.1 Donut expression, verbatim, so the regression stays visible. */
function legacySelfPct(segments) {
  const safe = Array.isArray(segments) ? segments : [];
  const total = safe.reduce((s, seg) => s + (Number(seg.value) || 0), 0);
  const selfSeg = safe.find((s) => s.isSelf) || safe[0];
  if (!(total > 0) || !selfSeg) return null;
  return ((Number(selfSeg.value) || 0) / total) * 100;
}

/** An engine summary as computeEngineSummary() emits it (the fields SOV needs). */
const engine = ({ sov, self, all, rivals = [] }) => ({
  engine: "aio",
  share_of_voice_pct: sov,
  self_mentions: self,
  total_brand_mentions: all,
  top_rivals: rivals,
  visibility_pct: 40,
});

// ---------------------------------------------------------------------------
// The 100% path
// ---------------------------------------------------------------------------

test("A8 — the shape that printed '100.0% share' now resolves to no number at all", () => {
  // Exactly what OverviewAnalytics builds for a scan with no scored rivals:
  // one self row carrying a visibility score, and no measured SOV anywhere.
  const rankedEntries = [{ name: "Zouk", value: 12.5, isSelf: true }];
  const result = {
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    competitors: [],
    perEngineSummaries: null,
    // the visibility numbers the old code reached for — deliberately present
    shareOfAiPct: 12.5,
    visibilityScore: 12.5,
  };

  assert.equal(legacySelfPct(rankedEntries), 100, "the old expression really did print 100%");

  const share = resolveShareOfVoice(result);
  assert.equal(share.state, SHARE_STATE.UNAVAILABLE);
  assert.equal(share.pct, null, "a share that was never measured is null, not 100 and not 0");
  assert.match(share.label, /not available/i);
  assert.equal(share.composition, null, "no composition means the bar draws nothing");
});

test("A8 — no visibility number anywhere in the record can produce a share", () => {
  // Self at 100 visibility, a rival at 0: the old arithmetic gives 100%.
  const result = {
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    visibilityScore: 100,
    shareOfAiPct: 100,
    competitors: [{ name: "Rival A", visibilityScore: 0, mentions: 0 }],
    perEngineSummaries: { aio: { visibility_pct: 100, share_of_ai_pct: 100 } },
  };
  const share = resolveShareOfVoice(result);
  assert.equal(share.pct, null);
  assert.equal(share.state, SHARE_STATE.UNAVAILABLE);
  assert.equal(share.reason, "not_computed");
});

test("A8 — 100 is only ever reachable when the pipeline itself measured 100", () => {
  // Rivals WERE tracked (share_of_voice_pct is a number, so hasRivalRoster was
  // true upstream) and none of them was named. That 100 is a measurement, and
  // it comes from the field — not from a one-entry division.
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: { aio: engine({ sov: 100, self: 6, all: 6 }) },
  });
  assert.equal(share.state, SHARE_STATE.MEASURED);
  assert.equal(share.pct, 100);
  assert.equal(share.engines.join(","), "aio");
});

// ---------------------------------------------------------------------------
// null vs a genuine 0
// ---------------------------------------------------------------------------

test("null share_of_voice_pct on every engine renders 'not available', never 0%", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: {
      aio: engine({ sov: null, self: 1, all: 1 }),
      perplexity: engine({ sov: null, self: 0, all: 0 }),
    },
  });
  assert.equal(share.state, SHARE_STATE.UNAVAILABLE);
  assert.equal(share.pct, null);
  assert.notEqual(share.pct, 0, "undefined and zero are different facts");
  assert.match(share.label, /not available/i);
  assert.match(share.detail, /not the same as a 0% share/);
});

test("a measured 0% stays a number — it is not folded into 'not available'", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: {
      aio: engine({ sov: 0, self: 0, all: 8, rivals: [{ name: "Rival A", mentions: 8 }] }),
    },
  });
  assert.equal(share.state, SHARE_STATE.MEASURED);
  assert.equal(share.pct, 0);
  assert.equal(share.label, null, "a measured zero prints a percentage, not a state chip");
  const self = share.composition.find((s) => s.isSelf);
  assert.equal(self.pct, 0);
});

test("engines that assessed a roster but recorded no mentions is a measured zero", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: { aio: engine({ sov: 0, self: 0, all: 0 }) },
  });
  assert.equal(share.state, SHARE_STATE.MEASURED);
  assert.equal(share.pct, 0);
  assert.equal(share.composition, null, "0 of 0 mentions has no split to draw");
});

// ---------------------------------------------------------------------------
// Reading the real field
// ---------------------------------------------------------------------------

test("a single engine's share_of_voice_pct is reported as-is", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: {
      aio: engine({
        sov: 25,
        self: 2,
        all: 8,
        rivals: [{ name: "Rival A", mentions: 4 }, { name: "Rival B", mentions: 2 }],
      }),
    },
  });
  assert.equal(share.state, SHARE_STATE.MEASURED);
  assert.equal(share.pct, 25);
  assert.deepEqual(
    share.composition.map((s) => [s.name, s.pct]),
    [["Zouk", 25], ["Rival A", 50], ["Rival B", 25]]
  );
});

test("two engines are unioned over mention counts, never averaged", () => {
  // aio 1/2 = 50%, perplexity 1/8 = 12.5%. The mean is 31.25 and is wrong;
  // the union is 2/10 = 20%.
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: {
      aio: engine({ sov: 50, self: 1, all: 2, rivals: [{ name: "Rival A", mentions: 1 }] }),
      perplexity: engine({ sov: 12.5, self: 1, all: 8, rivals: [{ name: "Rival A", mentions: 7 }] }),
    },
  });
  assert.equal(share.pct, 20);
  assert.notEqual(share.pct, 31.3, "a mean of two ratios is not a share of voice");
  assert.deepEqual(share.engines, ["aio", "perplexity"]);
  assert.deepEqual(
    share.composition.map((s) => [s.name, s.pct]),
    [["Zouk", 20], ["Rival A", 80]]
  );
});

test("an engine reporting null is excluded from the union entirely", () => {
  // The null engine measured no roster; its self-only mentions would drag the
  // union toward 100 if they were counted.
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: {
      aio: engine({ sov: null, self: 9, all: 9 }),
      perplexity: engine({ sov: 20, self: 1, all: 5, rivals: [{ name: "Rival A", mentions: 4 }] }),
    },
  });
  assert.equal(share.pct, 20);
  assert.deepEqual(share.engines, ["perplexity"]);
});

test("rivals beyond the pipeline's top-ten cap surface as one explicit remainder", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: {
      aio: engine({ sov: 10, self: 1, all: 10, rivals: [{ name: "Rival A", mentions: 4 }] }),
    },
  });
  const other = share.composition.find((s) => s.isOther);
  assert.ok(other, "the unnamed 50% must be named as something");
  assert.equal(other.pct, 50);
  assert.equal(
    share.composition.reduce((s, x) => s + x.pct, 0),
    100
  );
});

test("two engines reporting a share without their mention counts refuse to combine", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: {
      aio: { share_of_voice_pct: 50 },
      perplexity: { share_of_voice_pct: 10 },
    },
  });
  assert.equal(share.state, SHARE_STATE.UNAVAILABLE);
  assert.equal(share.pct, null);
  assert.equal(share.reason, "engine_counts_missing");
});

test("one engine without mention counts still reports its own ratio", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    perEngineSummaries: { aio: { share_of_voice_pct: 37.5 } },
  });
  assert.equal(share.state, SHARE_STATE.MEASURED);
  assert.equal(share.pct, 37.5);
  assert.equal(share.composition, null);
});

test("a scan-level share_of_voice_pct wins the headline when the pipeline persists one", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    summary_stats: { share_of_voice_pct: 18.2 },
    perEngineSummaries: { aio: engine({ sov: 18.2, self: 2, all: 11 }) },
  });
  assert.equal(share.state, SHARE_STATE.MEASURED);
  assert.equal(share.pct, 18.2);
});

test("a composition that contradicts the scan-level number is dropped, not drawn", () => {
  const share = resolveShareOfVoice({
    brand: "Zouk",
    rosterSource: ROSTER_SOURCE.EXTRACTED,
    shareOfVoicePct: 18.2,
    perEngineSummaries: {
      aio: engine({ sov: 50, self: 5, all: 10, rivals: [{ name: "Rival A", mentions: 5 }] }),
    },
  });
  assert.equal(share.pct, 18.2);
  assert.equal(share.composition, null, "a bar whose self slice says 50% cannot sit under 18.2%");
});

test("a record with no scan and no engines is not available, and says which", () => {
  const share = resolveShareOfVoice({ brand: "Zouk", rosterSource: null });
  assert.equal(share.state, SHARE_STATE.UNAVAILABLE);
  assert.equal(share.reason, "no_engine_summaries");
  assert.equal(share.label, NOT_AVAILABLE_LABEL);
  assert.match(share.detail, /never computed/);
});

test("resolveShareOfVoice never throws on a malformed record", () => {
  for (const bad of [null, undefined, {}, { perEngineSummaries: [] }, { perEngineSummaries: 7 }]) {
    const share = resolveShareOfVoice(bad);
    assert.equal(share.pct, null);
    assert.notEqual(share.state, SHARE_STATE.MEASURED);
  }
});

// ---------------------------------------------------------------------------
// Roster state still wins (R0.3.2 must not be re-opened by this change)
// ---------------------------------------------------------------------------

test("an offline rival extractor outranks any engine field", () => {
  for (const source of [ROSTER_SOURCE.UNAVAILABLE, ROSTER_SOURCE.CARRIED_FORWARD]) {
    const share = resolveShareOfVoice({
      brand: "Zouk",
      rosterSource: source,
      perEngineSummaries: { aio: engine({ sov: 100, self: 3, all: 3 }) },
    });
    assert.equal(share.state, SHARE_STATE.NOT_ASSESSED, source);
    assert.equal(share.pct, null, source);
    assert.equal(share.label, "Not assessed — rival extraction offline", source);
  }
});

// ---------------------------------------------------------------------------
// Source walkers — the components must not keep their own copy of the rule
// ---------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel) => readFile(path.join(REPO, rel), "utf8");

test("WALKER — the panel resolves the measured share and stops feeding the donut rankedEntries", async () => {
  const src = await read("src/components/dashboard/RankAndSharePanel.jsx");
  assert.match(src, /resolveShareOfVoice\(result\)/, "the panel must resolve the measured share");
  assert.match(src, /share=\{share\}/, "and hand it to the Donut");
  assert.doesNotMatch(
    src,
    /segments=\{rankedEntries\}/,
    "handing the visibility ranking to the donut IS the bug"
  );
});

test("WALKER — the donut contains no share arithmetic of its own", async () => {
  const src = await read("src/components/perceev/charts/Donut.jsx");
  const props = /export const Donut = \(\{([^}]*)\}/.exec(src);
  assert.ok(props, "Donut must still destructure its props");
  assert.doesNotMatch(
    props[1],
    /\bsegments\b/,
    "the segments prop is gone; the donut is handed a measurement, not a ranking"
  );
  // `const total = safe.reduce(...)` was the denominator behind the 100%.
  assert.doesNotMatch(src, /const total\s*=/, "the donut keeps no total to divide by");
  assert.doesNotMatch(src, /seg\.value/, "the donut must not read visibility values");
  assert.match(src, /share\?\.pct/, "the headline reads the resolved measurement");
  assert.match(src, /rosterState\.assessable/, "R0.3.2's gate stays");
});

test("WALKER — a null share renders an em dash plus a state chip, never a bare 0", async () => {
  const src = await read("src/components/perceev/charts/Donut.jsx");
  assert.match(src, /selfPct == null \? '—' : formatPercent\(selfPct\)/, "em dash for null");
  assert.match(src, /-state-chip/, "and a chip naming the state beside it");
  assert.doesNotMatch(src, /pct \?\? 0/, "never ?? 0 on a metric");
});
