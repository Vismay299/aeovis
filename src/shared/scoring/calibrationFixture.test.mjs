import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LABEL_SCHEMA_VERSION,
  validateLabel,
  validateCalibrationFixture,
} from "./calibrationFixture.js";

const label = (over = {}) => ({
  result_id: "3f2c-result",
  prompt_text: "best vitrified tile brands in india",
  answer_text: "Kajaria, Somany and Italica are commonly recommended...",
  brand: "Italica",
  mentioned: true,
  position: 3,
  sentiment: 0,
  labelled_by: "vismay",
  labelled_at: "2026-08-29T10:00:00.000Z",
  ...over,
});

const fixture = (labels) => ({
  schema_version: LABEL_SCHEMA_VERSION,
  protocol: "test_reports/baseline-2026-08/LABELLING-PROTOCOL.md",
  labels,
});

/** 60 labels with a realistic 50/50 split. */
const balanced = (n = 60) =>
  Array.from({ length: n }, (_, i) =>
    label({
      result_id: `result-${i}`,
      mentioned: i % 2 === 0,
      position: i % 2 === 0 ? (i % 9) + 1 : null,
    })
  );

test("a well-formed label validates", () => {
  assert.deepEqual(validateLabel(label()), []);
});

test("THE LOAD-BEARING RULE — a missing `mentioned` is rejected, never read as false", () => {
  // A label nobody filled in must not silently become a negative example. That
  // is how a judge gets calibrated against absence.
  const { mentioned, ...without } = label();
  const problems = validateLabel(without);
  assert.ok(problems.some((p) => /must be an explicit true or false/.test(p)), problems.join("; "));
});

test("mentioned:true requires a real position", () => {
  assert.ok(validateLabel(label({ position: null })).length > 0);
  assert.ok(validateLabel(label({ position: 0 })).length > 0);
  assert.ok(validateLabel(label({ position: 2.5 })).length > 0);
  assert.ok(validateLabel(label({ position: 999 })).length > 0);
});

test("mentioned:false must NOT carry a position", () => {
  assert.deepEqual(validateLabel(label({ mentioned: false, position: null })), []);
  assert.ok(validateLabel(label({ mentioned: false, position: 3 })).length > 0);
});

test("an uncertain label must say what made it hard", () => {
  assert.ok(validateLabel(label({ uncertain: true })).some((p) => /note is required/.test(p)));
  assert.deepEqual(validateLabel(label({ uncertain: true, note: "brand named only in a citation URL" })), []);
});

test("sentiment is constrained, and optional", () => {
  assert.deepEqual(validateLabel(label({ sentiment: null })), []);
  assert.deepEqual(validateLabel(label({ sentiment: -1 })), []);
  assert.ok(validateLabel(label({ sentiment: 2 })).length > 0);
});

test("provenance is required — an unattributed label cannot be audited", () => {
  for (const field of ["result_id", "brand", "labelled_by", "labelled_at", "prompt_text", "answer_text"]) {
    const bad = label({ [field]: "" });
    assert.ok(validateLabel(bad).some((p) => p.includes(field)), `${field} must be required`);
  }
});

test("a 60-label balanced fixture validates", () => {
  const out = validateCalibrationFixture(fixture(balanced(60)));
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  assert.equal(out.counts.total, 60);
  assert.equal(out.counts.mentioned, 30);
});

test("the fixture must hold 60-100 labels", () => {
  assert.ok(validateCalibrationFixture(fixture(balanced(59))).problems.some((p) => /60-100/.test(p)));
  assert.ok(validateCalibrationFixture(fixture(balanced(60))).ok);
  assert.ok(validateCalibrationFixture(fixture(balanced(100))).ok);
  assert.ok(validateCalibrationFixture(fixture(balanced(102))).problems.some((p) => /60-100/.test(p)));
});

test("A ONE-SIDED SET IS REJECTED — a constant-answer judge would score perfectly on it", () => {
  const allYes = Array.from({ length: 60 }, (_, i) => label({ result_id: `r-${i}` }));
  const out = validateCalibrationFixture(fixture(allYes));
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => /too one-sided/.test(p)), out.problems.join("; "));
});

test("duplicate result_id+brand is rejected — the same answer labelled twice inflates agreement", () => {
  const rows = balanced(60);
  rows[59] = { ...rows[0] };
  const out = validateCalibrationFixture(fixture(rows));
  assert.ok(out.problems.some((p) => /duplicates result_id\+brand/.test(p)));
});

test("the fixture must name the protocol it was labelled under", () => {
  const f = fixture(balanced(60));
  delete f.protocol;
  assert.ok(validateCalibrationFixture(f).problems.some((p) => /protocol must name/.test(p)));
});

test("a wrong schema_version is rejected rather than coerced", () => {
  const f = { ...fixture(balanced(60)), schema_version: 99 };
  assert.ok(validateCalibrationFixture(f).problems.some((p) => /schema_version/.test(p)));
});

test("GUARD — the labelling protocol document exists and is honest about the empty corpus", async () => {
  const md = await readFile(
    new URL("../../../test_reports/baseline-2026-08/LABELLING-PROTOCOL.md", import.meta.url),
    "utf8"
  );
  assert.match(md, /\*\*Status: LIVE\.\*\*/);
  assert.match(md, /mentioned/i);
  assert.match(md, /uncertain/i);
  assert.match(md, /no labels have been produced/i, "must not imply labelling has happened");
});

test("GUARD — no calibration fixture is committed yet, and nothing pretends otherwise", async () => {
  // If someone commits one, this test's failure is the prompt to also run it
  // through validateCalibrationFixture in CI.
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../../../test_reports/baseline-2026-08/", import.meta.url);
  const files = await readdir(dir);
  const fixtures = files.filter((f) => f.endsWith(".labels.json"));
  assert.deepEqual(
    fixtures,
    [],
    `calibration fixtures now exist (${fixtures}) — add a test that validates each with ` +
      `validateCalibrationFixture, then delete this guard.`
  );
});
