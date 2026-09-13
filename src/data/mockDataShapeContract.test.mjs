import test from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_RESULT, buildMockResult } from "./mockData.js";
import { summarizeEngineSlice } from "../lib/scoring/enginePipeline.js";
import { resolveShareOfVoice, SHARE_STATE, NOT_AVAILABLE_LABEL } from "../components/perceev/charts/shareOfVoice.js";

/**
 * Shape Contract Guard (R2.7.7)
 *
 * Asserts that the demo fixture in src/data/mockData.js satisfies the exact
 * shape contract emitted by the real scan producer (summarizeEngineSlice in
 * src/lib/scoring/enginePipeline.js), including share_of_voice_pct, mention counts,
 * and citation denominator fields.
 *
 * Any future engine pipeline schema addition fails loudly here rather than
 * silently degrading the demo surfaces (/ and /scan).
 */

/** Helper to validate an engine summary against summarizeEngineSlice's emitted keys */
function assertEngineSummaryShape(summary, engineName, expectedKeys) {
  assert.ok(summary, `perEngineSummaries.${engineName} must exist`);
  assert.equal(typeof summary, "object", `perEngineSummaries.${engineName} must be an object`);

  const missingKeys = expectedKeys.filter((key) => !(key in summary));
  assert.deepEqual(
    missingKeys,
    [],
    `perEngineSummaries.${engineName} is missing real scan fields from summarizeEngineSlice: ${missingKeys.join(", ")}`
  );

  for (const key of expectedKeys) {
    assert.notEqual(
      summary[key],
      undefined,
      `perEngineSummaries.${engineName}.${key} must not be undefined`
    );
  }
}

test("R2.7.7 GUARD — SAMPLE_RESULT per-engine summaries satisfy summarizeEngineSlice shape contract", () => {
  const dummyRow = {
    engine: "aio",
    is_branded_query: false,
    answer_present: true,
    visible: true,
    brand_mentioned_in_text: true,
    brand_cited: true,
    brands: [
      { name: "Brand", isSelf: true, is_self: true, mentioned: true },
      { name: "Rival", isSelf: false, is_self: false, mentioned: false },
    ],
  };
  const realProducerOutput = summarizeEngineSlice([dummyRow], "aio");
  const expectedKeys = Object.keys(realProducerOutput);

  assert.ok(expectedKeys.length >= 25, "real producer emits complete schema");
  assert.ok(expectedKeys.includes("share_of_voice_pct"));
  assert.ok(expectedKeys.includes("self_mentions"));
  assert.ok(expectedKeys.includes("total_brand_mentions"));
  assert.ok(expectedKeys.includes("visible_non_branded"));
  assert.ok(expectedKeys.includes("citation_denominator"));

  const engines = Object.keys(SAMPLE_RESULT.perEngineSummaries || {});
  assert.ok(engines.length > 0, "SAMPLE_RESULT must have at least one engine summary");

  for (const engine of engines) {
    assertEngineSummaryShape(SAMPLE_RESULT.perEngineSummaries[engine], engine, expectedKeys);
  }
});

test("R2.7.7 TEETH — shape contract guard throws if any producer field is omitted", () => {
  const dummyRow = {
    engine: "aio",
    is_branded_query: false,
    answer_present: true,
    visible: true,
    brand_mentioned_in_text: true,
    brand_cited: true,
    brands: [
      { name: "Brand", isSelf: true, is_self: true, mentioned: true },
    ],
  };
  const expectedKeys = Object.keys(summarizeEngineSlice([dummyRow], "aio"));

  // Create an incomplete engine summary missing share_of_voice_pct
  const incompleteSummary = { ...SAMPLE_RESULT.perEngineSummaries[Object.keys(SAMPLE_RESULT.perEngineSummaries)[0]] };
  delete incompleteSummary.share_of_voice_pct;

  assert.throws(
    () => assertEngineSummaryShape(incompleteSummary, "test_engine", expectedKeys),
    (err) => {
      assert.match(err.message, /missing real scan fields/);
      assert.match(err.message, /share_of_voice_pct/);
      return true;
    },
    "shape contract guard must have teeth when a field is missing"
  );
});

test("R2.7.7 RESOLVER — SAMPLE_RESULT resolves to measured share of voice, not 'not available'", () => {
  const sov = resolveShareOfVoice(SAMPLE_RESULT);

  assert.equal(sov.state, SHARE_STATE.MEASURED);
  assert.equal(typeof sov.pct, "number");
  assert.ok(sov.pct > 0 && sov.pct < 100, `measured SOV must be a real percentage, got ${sov.pct}`);
  assert.equal(sov.label, null, "measured SOV has no fallback label");
  assert.notEqual(sov.label, NOT_AVAILABLE_LABEL);

  assert.ok(Array.isArray(sov.composition), "composition must be an array of slices");
  assert.ok(sov.composition.length >= 2, "composition must show self and rivals");

  const selfSlice = sov.composition.find((s) => s.isSelf);
  assert.ok(selfSlice, "composition must have self slice");
  assert.equal(selfSlice.pct, sov.pct);
});

test("R2.7.7 FIELDS — SAMPLE_RESULT carries real scan fields at scan level and in results rows", () => {
  assert.equal(typeof SAMPLE_RESULT.share_of_voice_pct, "number");
  assert.equal(typeof SAMPLE_RESULT.self_mentions, "number");
  assert.equal(typeof SAMPLE_RESULT.total_brand_mentions, "number");

  assert.equal(SAMPLE_RESULT.self_mentions, 13);
  assert.equal(SAMPLE_RESULT.total_brand_mentions, 28);
  assert.equal(SAMPLE_RESULT.share_of_voice_pct, 46.4);

  // Results rows carry brands with mention information
  for (const row of SAMPLE_RESULT.results) {
    assert.ok(Array.isArray(row.brands), "every row carries brands array");
    assert.ok(row.brands.length >= 1, "brands array has entries");
    assert.ok(row.brands.every((b) => typeof b.mentioned === "boolean"), "every brand has mentioned boolean");
  }
});
