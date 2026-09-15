/**
 * R2.8.3 / finding A11 — the null the scan page used to render as "0%".
 *
 * The status route answers a transient DB read failure with
 * `{ status: "unknown", progress_pct: null, transient_error: true }`. Before
 * this task the page bound that null straight into `{progress}% complete` and
 * `scaleX(progress / 100)`: the label collapsed to "% complete" and a bar at
 * 62% snapped back to empty, on a run that was still perfectly healthy.
 *
 * These tests pin the three properties that make that impossible:
 *   1. unknown never becomes zero,
 *   2. progress never moves backwards inside a run,
 *   3. an unknown tick is visible as "reconnecting", not as silence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONNECTION_LIVE,
  CONNECTION_RECONNECTING,
  initialScanProgress,
  beginScanProgress,
  applyScanReading,
  applyScanUnknown,
  isReconnecting,
  progressLabel,
  progressFraction,
} from "./scanProgress.js";

test("a fresh run has no measured progress — null, not 0", () => {
  const started = beginScanProgress();
  assert.equal(started.progress, null, "nothing has been measured yet");
  assert.equal(started.stage, 0);
  assert.equal(started.connection, CONNECTION_LIVE);

  const label = progressLabel(started);
  assert.equal(label.known, false);
  assert.equal(label.text, "—", "unknown renders as an em dash, never 0%");
  assert.equal(label.chip, "Progress not reported yet", "and an unknown state must be named");
});

test("A11 — a null progress_pct does NOT rewind a run in flight", () => {
  let state = applyScanReading(beginScanProgress(), { stage: 2, progressPct: 62 });
  assert.equal(progressLabel(state).text, "62% complete");

  // The exact payload of the transient envelope, arriving as a reading.
  state = applyScanReading(state, { stage: 2, progressPct: null });
  assert.equal(state.progress, 62, "null must not overwrite a known percentage");
  assert.equal(progressLabel(state).text, "62% complete");
  assert.equal(progressFraction(state), 0.62);

  // …and as an undefined, which is what a missing field deserializes to.
  state = applyScanReading(state, { stage: 2, progressPct: undefined });
  assert.equal(state.progress, 62);
});

test("A11 — a transient tick renders 'reconnecting' and holds stage and progress", () => {
  const live = applyScanReading(beginScanProgress(), { stage: 2, progressPct: 62 });
  const blind = applyScanUnknown(live, { reason: "status_unreadable" });

  assert.equal(isReconnecting(blind), true);
  assert.equal(blind.connection, CONNECTION_RECONNECTING);
  assert.equal(blind.unknownReason, "status_unreadable", "the reason must survive for logs/UI");
  assert.equal(blind.progress, 62, "the bar holds where the user last saw it");
  assert.equal(blind.stage, 2, "the transient envelope must not drag the stage back to 0");

  const label = progressLabel(blind);
  assert.equal(label.text, "62% complete");
  assert.equal(label.chip, "Reconnecting", "the page must say it is reconnecting");
});

test("an unknown tick before any reading stays unknown — it never invents 0%", () => {
  const blind = applyScanUnknown(beginScanProgress(), { reason: "poll_failed: boom" });
  assert.equal(blind.progress, null);
  assert.equal(progressLabel(blind).known, false);
  assert.equal(progressLabel(blind).text, "—");
  assert.equal(progressLabel(blind).chip, "Reconnecting");
  assert.equal(progressFraction(blind), 0, "an empty bar is fine — the LABEL must not lie");
});

test("a real reading clears the reconnecting state", () => {
  const blind = applyScanUnknown(
    applyScanReading(beginScanProgress(), { stage: 1, progressPct: 20 }),
    { reason: "poll_failed" }
  );
  const back = applyScanReading(blind, { stage: 2, progressPct: 40 });
  assert.equal(back.connection, CONNECTION_LIVE);
  assert.equal(back.unknownReason, null);
  assert.equal(back.progress, 40);
  assert.equal(progressLabel(back).chip, null, "no chip when the number is live and known");
});

test("progress and stage are monotonic within a run", () => {
  let state = applyScanReading(beginScanProgress(), { stage: 3, progressPct: 80 });
  state = applyScanReading(state, { stage: 0, progressPct: 5 });
  assert.equal(state.progress, 80, "an out-of-order poll cannot rewind the bar");
  assert.equal(state.stage, 3, "nor the stage");

  state = applyScanReading(state, { stage: 4, progressPct: 100 });
  assert.equal(state.progress, 100);
  assert.equal(state.stage, 4);
});

test("a new run is the only way back to the start", () => {
  const finished = applyScanReading(beginScanProgress(), { stage: 4, progressPct: 100 });
  const fresh = beginScanProgress();
  assert.equal(fresh.progress, null);
  assert.equal(fresh.stage, 0);
  assert.notEqual(finished.progress, fresh.progress);
});

test("measured zero is distinguishable from never measured", () => {
  const measuredZero = applyScanReading(beginScanProgress(), { stage: 0, progressPct: 0 });
  const neverMeasured = beginScanProgress();

  assert.equal(measuredZero.progress, 0);
  assert.equal(progressLabel(measuredZero).known, true);
  assert.equal(progressLabel(measuredZero).text, "0% complete");

  assert.equal(neverMeasured.progress, null);
  assert.equal(progressLabel(neverMeasured).known, false);
  assert.notEqual(progressLabel(measuredZero).text, progressLabel(neverMeasured).text);
});

test("garbage percentages are clamped, not trusted", () => {
  const base = beginScanProgress();
  assert.equal(applyScanReading(base, { stage: 1, progressPct: 140 }).progress, 100);
  assert.equal(applyScanReading(base, { stage: 1, progressPct: -20 }).progress, 0);
  assert.equal(
    applyScanReading(base, { stage: 1, progressPct: Number.NaN }).progress,
    null,
    "NaN is unknown, not zero"
  );
  assert.equal(
    applyScanReading(base, { stage: 1, progressPct: "62" }).progress,
    null,
    "a string is not a measurement"
  );
  assert.equal(progressFraction({ ...base, progress: 100 }), 1);
});

/**
 * The reducer is only a fix if the page uses it. There is no React renderer in
 * this tree, so the binding is checked at the source: the page must go through
 * these helpers and must not reintroduce the raw interpolation that rendered
 * "% complete" from a null.
 */
test("GUARD — the scan page renders progress through this module, not from a raw number", async () => {
  const pageFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../app/scan/page.js"
  );
  const src = await readFile(pageFile, "utf8");

  assert.match(src, /from '@\/lib\/scanProgress'/, "the page must use the reducer");
  assert.match(src, /progressLabel\(progressState\)/, "the label must come from progressLabel");
  assert.match(src, /progressFraction\(progressState\)/, "the bar fill must come from progressFraction");
  assert.match(src, /applyScanUnknown/, "the page must handle a tick that produced no reading");
  assert.match(src, /Reconnecting/, "the reconnecting state must be rendered, not just tracked");

  assert.doesNotMatch(
    src,
    /\{progress\}% complete/,
    "this is the A11 defect verbatim: a null progress renders as '% complete'"
  );
  assert.doesNotMatch(
    src,
    /progress \/ 100/,
    "a raw progress/100 rewinds the bar to empty when progress is null"
  );
  assert.doesNotMatch(
    src,
    /progress[A-Za-z]*\s*\?\?\s*0/,
    "an unknown percentage must never be coerced to 0"
  );
});

test("the initial (pre-scan) state has no stage and claims nothing", () => {
  const idle = initialScanProgress();
  assert.equal(idle.stage, -1);
  assert.equal(idle.progress, null);
  assert.equal(isReconnecting(idle), false);
  // Defensive: the helpers must tolerate being called before any state exists.
  assert.equal(progressLabel(undefined).text, "—");
  assert.equal(progressFraction(undefined), 0);
  assert.equal(applyScanUnknown(undefined, {}).connection, CONNECTION_RECONNECTING);
  assert.equal(applyScanReading(undefined, { stage: 1, progressPct: 10 }).progress, 10);
});
