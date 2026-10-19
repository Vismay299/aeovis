/**
 * The customer portal's scan loading bar.
 *
 * The portal used to print a running scan as "generating_prompts · 10%" in a
 * list row, never polled the job, and rendered dark whenever the OS was dark.
 * These tests pin what replaced that:
 *   1. an unknown value is a still "not measured" rail; the sweep is opt-in and
 *      never draws "unknown" as 0%,
 *   2. the stepper marks finished stages done and the running one current,
 *   3. the progress card shows the live percentage and stage name,
 *   4. the tracker polls the status route that also rescues stalled chunks,
 *   5. the portal shell and its tokens stay light inside a dark root.
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileJsx, renderToHtml, textOf } from "../../lib/renderHarness.mjs";
import * as scanProgress from "../../lib/scanProgress.js";
import * as scanCompletion from "../../lib/scanCompletion.js";
import { legacyTerminalOutcome } from "../../lib/scanOutcome.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const nextLink = {
  __esModule: true,
  default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children),
};

async function loadUi() {
  return compileJsx(path.join(here, "ui.jsx"), {
    modules: new Map([["next/link", nextLink]]),
    autoNull: ["lucide-react"],
  });
}

async function loadTracker() {
  return compileJsx(path.join(here, "useScanTracker.js"), {
    modules: new Map([["react", React], ["@/lib/scanProgress", scanProgress]]),
  });
}

test("ProgressBar: a bare unknown value is a still 'not measured' rail, not a sweep", async () => {
  const { ProgressBar } = await loadUi();
  const html = renderToHtml(ProgressBar, { value: null, label: "ChatGPT score" });
  assert.doesNotMatch(html, /pv-progress--indeterminate/, "the sweep must be opt-in");
  assert.match(html, /pv-progress--unmeasured/, "an unmeasured bar must read differently from a measured 0%");
  assert.doesNotMatch(html, /pv-progress__fill/, "an unmeasured bar draws no fill");
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="ChatGPT score: not measured"/);
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.doesNotMatch(textOf(html), /0%/);
});

test("ProgressBar: only an explicit indeterminate sweeps, and is never announced as 0%", async () => {
  const { ProgressBar } = await loadUi();
  const html = renderToHtml(ProgressBar, { value: null, indeterminate: true, label: "Scan progress" });
  assert.match(html, /pv-progress--indeterminate/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuetext="In progress"/);
  assert.doesNotMatch(html, /pv-progress--unmeasured/);
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.doesNotMatch(textOf(html), /0%/);
});

test("ProgressBar: a known value fills to that fraction and is announced", async () => {
  const { ProgressBar } = await loadUi();
  const html = renderToHtml(ProgressBar, { value: 42, active: true });
  assert.match(html, /aria-valuenow="42"/);
  assert.match(html, /scaleX\(0\.42\)/);
  assert.match(html, /is-active/);
});

test("StageSteps: stages before current are done, current is current", async () => {
  const { StageSteps } = await loadUi();
  const steps = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];
  const html = renderToHtml(StageSteps, { steps, current: 2 });
  assert.equal((html.match(/is-done/g) || []).length, 2);
  assert.equal((html.match(/is-current/g) || []).length, 1);
  assert.match(html, /aria-current="step"/);
});

test("scanStageIndex maps every worker status onto the stepper", async () => {
  const { scanStageIndex, SCAN_STAGES, ACTIVE_SCAN_STATUSES } = await loadTracker();
  assert.deepEqual(ACTIVE_SCAN_STATUSES.map(scanStageIndex), [0, 1, 2, 3]);
  assert.equal(scanStageIndex("complete"), SCAN_STAGES.length);
  assert.equal(scanStageIndex("something_new"), -1);
});

test("the tracker polls the status route, which is what rescues a stalled scan", async () => {
  const source = await readFile(path.join(here, "useScanTracker.js"), "utf8");
  assert.match(source, /\/api\/scan\/\$\{encodeURIComponent\(jobId\)\}\/status/);
  const route = await readFile(path.join(here, "../../app/api/scan/[job_id]/status/route.js"), "utf8");
  assert.match(route, /keepAlive\(\(\) => runScanChunk\(job\.id\)/, "status route must still rescue stalled chunks");
});

async function renderCard(scan) {
  const ui = await loadUi();
  const tracker = await loadTracker();
  const { ScanProgressCard } = await compileJsx(path.join(here, "ScanProgressCard.jsx"), {
    modules: new Map([
      ["react", React],
      ["./ui", ui],
      ["./useScanTracker", tracker],
      ["@/lib/scanCompletion", scanCompletion],
      ["./PortalShell", { usePortal: () => ({ scan, brand: { display_name: "Acme" } }) }],
    ]),
    autoNull: ["lucide-react"],
  });
  return renderToHtml(ScanProgressCard, {});
}

const baseScan = {
  job: { id: "job-1", status: "probing", created_at: new Date().toISOString() },
  active: true,
  percent: 37,
  stageIndex: 2,
  stage: { label: "Asking AI engines", detail: "Every question goes to each engine" },
  reconnecting: false,
  stalled: false,
  finished: null,
  starting: false,
  error: "",
  notice: "",
  start() {},
  dismiss() {},
};

test("ScanProgressCard: a running scan shows its percentage, stage and bar", async () => {
  const html = await renderCard(baseScan);
  const text = textOf(html);
  assert.match(text, /37%/);
  assert.match(text, /Asking AI engines…/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /data-testid="portal-scan-progress"/);
});

test("ScanProgressCard: no reading yet is an em dash, not 0%", async () => {
  const text = textOf(await renderCard({ ...baseScan, percent: null, stageIndex: 0, stage: { label: "Queued" } }));
  assert.match(text, /—/);
  assert.doesNotMatch(text, /\b0%/);
});

test("ScanProgressCard: a stalled scan says it resumes on its own", async () => {
  const text = textOf(await renderCard({ ...baseScan, stalled: true }));
  assert.match(text, /Taking longer than usual/);
});

test("ScanProgressCard: completed execution cannot turn failed or partial collection into success", async () => {
  for (const [outcome, tone, title] of [["failed", "error", "Collection failed"], ["partial", "warn", "Partial collection"], ["complete", "success", "Scan complete"], ["legacy", "info", "collection quality unknown"]]) {
    const html = await renderCard({ ...baseScan, active: false, finished: { status: "complete", resultId: "report-1", terminal_outcome: { ...legacyTerminalOutcome(), outcome } } });
    assert.ok(textOf(html).includes(title));
    assert.match(html, new RegExp(`pv-banner--${tone}`));
    if (outcome !== "complete") assert.doesNotMatch(html, /pv-banner--success/);
    assert.match(html, /\/portal\/scans\/report-1/);
  }
});

test("the portal inherits the shared light root instead of carrying an independent theme", async () => {
  const css = await readFile(path.join(here, "../../app/globals.css"), "utf8");
  const layout = await readFile(path.join(here, "../../app/layout.js"), "utf8");
  assert.match(css, /:root \{\s*\n\s*--paper:/);
  assert.match(layout, /<html[^>]*data-theme="light"[^>]*>/);
  assert.ok(!css.includes("prefers-color-scheme"));
  const shell = await readFile(path.join(here, "PortalShell.jsx"), "utf8");
  assert.ok(!shell.includes('data-theme='));
});
