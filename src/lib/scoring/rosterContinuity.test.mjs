import test from "node:test";
import assert from "node:assert/strict";
import {
  ROSTER_SOURCE,
  carriedForwardRosterFromResultBrands,
  resolveCompetitorRoster,
  isRosterAssessable,
  describeRosterState,
} from "./rosterContinuity.js";
import { LlmUnavailableError } from "../llmErrors.js";

const silent = { warn: () => {} };

test("carriedForwardRosterFromResultBrands - drops self, dedupes case-insensitively, keeps first casing", () => {
  const roster = carriedForwardRosterFromResultBrands([
    { name: "Italica", is_self: true },
    { name: "Kajaria", is_self: false },
    { name: "kajaria", is_self: false },
    { name: "  ", is_self: false },
    { name: "Somany", is_self: false },
    { name: "Italica", is_self: true },
  ]);
  assert.deepEqual(
    roster.map((r) => r.name),
    ["Kajaria", "Somany"]
  );
  assert.ok(roster.every((r) => r.source === ROSTER_SOURCE.CARRIED_FORWARD));
});

test("carriedForwardRosterFromResultBrands - empty/nullish input yields an empty roster, not a throw", () => {
  assert.deepEqual(carriedForwardRosterFromResultBrands(null), []);
  assert.deepEqual(carriedForwardRosterFromResultBrands([]), []);
});

test("resolveCompetitorRoster - extraction works: roster_source is 'extracted' and nothing is carried", async () => {
  let loaded = false;
  const out = await resolveCompetitorRoster({
    extract: async () => [{ name: "Kajaria", source: "discovered" }],
    loadPreviousRoster: async () => {
      loaded = true;
      return [];
    },
    logger: silent,
  });
  assert.equal(out.roster_source, ROSTER_SOURCE.EXTRACTED);
  assert.equal(out.extraction_offline, false);
  assert.deepEqual(out.competitors.map((c) => c.name), ["Kajaria"]);
  assert.equal(loaded, false, "must not touch the previous roster when extraction succeeded");
});

test("REPEAT SCAN — extractor offline with a previous roster carries it forward, labelled", async () => {
  const out = await resolveCompetitorRoster({
    extract: async () => {
      throw new LlmUnavailableError("no key", { reason: "missing_key" });
    },
    loadPreviousRoster: async () => [
      { name: "Italica", is_self: true },
      { name: "Kajaria", is_self: false },
      { name: "Somany", is_self: false },
    ],
    logger: silent,
  });
  assert.equal(out.roster_source, ROSTER_SOURCE.CARRIED_FORWARD);
  assert.equal(out.extraction_offline, true);
  assert.deepEqual(out.competitors.map((c) => c.name), ["Kajaria", "Somany"]);
  assert.match(out.extraction_error, /no key/);
  // The whole point: this scan must NOT be treated as a measured roster.
  assert.equal(isRosterAssessable(out.roster_source), false);
});

test("FIRST SCAN — extractor offline with no previous roster yields 'unavailable', never a clean empty", async () => {
  const out = await resolveCompetitorRoster({
    extract: async () => {
      throw new LlmUnavailableError("exhausted", { reason: "exhausted_retries" });
    },
    loadPreviousRoster: async () => [],
    logger: silent,
  });
  assert.equal(out.roster_source, ROSTER_SOURCE.UNAVAILABLE);
  assert.equal(out.extraction_offline, true);
  assert.deepEqual(out.competitors, []);
  // This is the false-100% guard: an empty roster is only safe because the
  // label travels with it and marks the scan unassessable.
  assert.equal(isRosterAssessable(out.roster_source), false);
});

test("resolveCompetitorRoster - a NON-LLM error still propagates (no blanket swallow)", async () => {
  const boom = new TypeError("competitorObjects.map is not a function");
  await assert.rejects(
    () =>
      resolveCompetitorRoster({
        extract: async () => {
          throw boom;
        },
        loadPreviousRoster: async () => [{ name: "Kajaria" }],
        logger: silent,
      }),
    (e) => e === boom
  );
});

test("resolveCompetitorRoster - a DB failure loading the previous roster is NOT swallowed either", async () => {
  await assert.rejects(
    () =>
      resolveCompetitorRoster({
        extract: async () => {
          throw new LlmUnavailableError("no key", { reason: "missing_key" });
        },
        loadPreviousRoster: async () => {
          throw new Error("supabase unreachable");
        },
        logger: silent,
      }),
    /supabase unreachable/
  );
});

test("resolveCompetitorRoster - user competitors configured: roster_source is 'configured'", async () => {
  const out = await resolveCompetitorRoster({
    userCompetitors: ["Kajaria", "Somany"],
    extract: async () => [
      { name: "Kajaria", source: "user" },
      { name: "Somany", source: "user" },
      { name: "Simpolo", source: "discovered" },
    ],
    loadPreviousRoster: async () => [],
    logger: silent,
  });
  assert.equal(out.roster_source, ROSTER_SOURCE.CONFIGURED);
  assert.equal(out.extraction_offline, false);
  assert.equal(isRosterAssessable(out.roster_source), true);
  assert.deepEqual(out.competitors.map((c) => c.name), ["Kajaria", "Somany", "Simpolo"]);
});

test("resolveCompetitorRoster - user competitors configured and extractor offline: preserves user roster as 'configured'", async () => {
  const out = await resolveCompetitorRoster({
    userCompetitors: ["Kajaria", "Somany"],
    extract: async () => {
      throw new LlmUnavailableError("timeout", { reason: "timeout" });
    },
    loadPreviousRoster: async () => [],
    logger: silent,
  });
  assert.equal(out.roster_source, ROSTER_SOURCE.CONFIGURED);
  assert.equal(out.extraction_offline, true);
  assert.equal(isRosterAssessable(out.roster_source), true);
  assert.deepEqual(out.competitors.map((c) => c.name), ["Kajaria", "Somany"]);
  assert.ok(out.competitors.every((c) => c.source === ROSTER_SOURCE.CONFIGURED));
});

test("isRosterAssessable - extracted, configured, or historical scans are assessable; offline are not", () => {
  assert.equal(isRosterAssessable(ROSTER_SOURCE.EXTRACTED), true);
  assert.equal(isRosterAssessable(ROSTER_SOURCE.CONFIGURED), true);
  assert.equal(isRosterAssessable(ROSTER_SOURCE.USER), true);
  assert.equal(isRosterAssessable(null), true, "historical scans carry no label — treated as measured");
  assert.equal(isRosterAssessable(undefined), true);
  assert.equal(isRosterAssessable(ROSTER_SOURCE.CARRIED_FORWARD), false);
  assert.equal(isRosterAssessable(ROSTER_SOURCE.UNAVAILABLE), false);
});

// ---------------------------------------------------------------------------
// R0.3.2 — the dashboard's offline state. describeRosterState is the single
// predicate the donut, the Rivals view and the verdict sentence all read.
// ---------------------------------------------------------------------------

test("describeRosterState - a measured roster renders the real numbers", () => {
  for (const src of [ROSTER_SOURCE.EXTRACTED, null, undefined]) {
    const state = describeRosterState(src);
    assert.equal(state.assessable, true);
    assert.equal(state.label, null);
  }
});

test("OFFLINE STATE — carried_forward reads 'Not assessed — rival extraction offline'", () => {
  const state = describeRosterState(ROSTER_SOURCE.CARRIED_FORWARD);
  assert.equal(state.assessable, false);
  assert.equal(state.label, "Not assessed — rival extraction offline");
  assert.match(state.detail, /carried forward/);
  // Must never claim the rivals were re-measured this scan.
  assert.match(state.detail, /could not look for rivals/);
});

test("OFFLINE STATE — unavailable reads the same headline and never claims 'no rivals found'", () => {
  const state = describeRosterState(ROSTER_SOURCE.UNAVAILABLE);
  assert.equal(state.assessable, false);
  assert.equal(state.label, "Not assessed — rival extraction offline");
  assert.match(state.detail, /not the same as finding no rivals/);
});

test("describeRosterState - the two offline states share one headline so surfaces cannot disagree", () => {
  assert.equal(
    describeRosterState(ROSTER_SOURCE.CARRIED_FORWARD).label,
    describeRosterState(ROSTER_SOURCE.UNAVAILABLE).label
  );
});
