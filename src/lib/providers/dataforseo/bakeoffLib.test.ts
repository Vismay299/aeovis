// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityMatching.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { mkdir, readFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { probeChatGpt } from "../../engines/openai.js";
import { probePerplexity } from "../../engines/perplexity.js";
import { probeTextEngine } from "../../scoring/enginePipeline.js";
import { assertEnvironment, computeMetrics, createGuardedFetch, createPrivateOutputDirectory, estimatePlan, loadPanel, parseArgs, planArms, probeCurrentProviderOnce, renderSummaryMarkdown } from "./bakeoffLib.ts";

const fixtureDir = "tests/fixtures/f02/bakeoff-run/";
const validArgv = ["--panel", "panel.json", "--run-id", "offcult-run-123", "--out", "C:\\private\\run", "--max-spend-usd", "0.8", "--confirm-spend", "0.8"];

test("refuses malformed or unsafe argument sets", () => {
  for (const argv of [
    [], ["--unknown", "x"], ["--panel"],
    ["--panel", "x", "--run-id", "Bad", "--dry-run"],
    ["--panel", "x", "--max-spend-usd", "26", "--dry-run"],
    ["--panel", "x", "--max-spend-usd", "0", "--dry-run"],
    ["--panel", "x", "--max-requests", "601", "--dry-run"],
    ["--panel", "x", "--max-requests", "0", "--dry-run"],
    ["--panel", "x", "--max-spend-usd", "0.8"],
    ["--panel", "x", "--max-spend-usd", "0.8", "--confirm-spend", "0.7"],
    ["--panel", "x", "--dry-run", "--unexpected", "x"],
  ]) assert.throws(() => parseArgs(argv));
  assert.equal(parseArgs(validArgv).maxSpendUsd, 0.8);
  assert.deepEqual(parseArgs(["--panel", "x", "--dry-run"]).arms, ["dfs_queued", "dfs_live"]);
});

test("environment guard accepts only a loopback live QA database without shared secrets", () => {
  assert.equal(assertEnvironment({ PGHOST: "127.0.0.1", PGDATABASE: "aeovis_live_qa" }, "C:\\repo", { out: "C:\\private\\run" }), true);
  assert.throws(() => assertEnvironment({ PGHOST: "db.example", PGDATABASE: "aeovis_live_qa" }, "C:\\repo"), /loopback/);
  assert.throws(() => assertEnvironment({ PGHOST: "localhost", PGDATABASE: "aeovis_live_qa", DATABASE_URL: "set" }, "C:\\repo"), /DATABASE_URL/);
  assert.throws(() => assertEnvironment({ PGHOST: "localhost", PGDATABASE: "aeovis_live_qa" }, "C:\\repo", { out: "C:\\repo\\inside" }), /outside the repository/);
  assert.throws(() => assertEnvironment({ PGHOST: "localhost", PGDATABASE: "aeovis_live_qa" }, "C:\\repo", { out: "C:\\Users\\Owner\\My Drive\\run" }), /Google Drive/);
});

test("panel validation never needs to expose prompt contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "f02-panel-"));
  const file = path.join(directory, "panel.json");
  try {
    await writeFile(file, JSON.stringify({ context: { country: "IN", language: "en" }, prompts: [{ text: "synthetic prompt" }] }));
    assert.equal((await loadPanel(file)).prompts.length, 1);
    await writeFile(file, JSON.stringify({ context: {}, prompts: [] }));
    await assert.rejects(loadPanel(file));
    await writeFile(file, JSON.stringify({ context: { country: "IN", language: "en" }, prompts: Array.from({ length: 61 }, () => ({ text: "synthetic" })) }));
    await assert.rejects(loadPanel(file));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("default plan stays under the B6 $0.80 ceiling", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "f02-panel-"));
  const file = path.join(directory, "panel.json");
  try {
    await writeFile(file, JSON.stringify({ context: { country: "IN", language: "en" }, prompts: Array.from({ length: 4 }, (_, i) => ({ text: `question ${i}` })) }));
    const args = parseArgs(["--panel", file, "--dry-run"]);
    const plan = planArms(await loadPanel(file), args);
    assert.equal(plan.length, 24);
    assert.ok(estimatePlan(plan) < 0.8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dry-run guarded fetch allows sandbox/catalogue hosts only and stops at N+1", async () => {
  let calls = 0;
  const guarded = createGuardedFetch({ allowHosts: ["sandbox.dataforseo.com", "api.dataforseo.com"], maxRequests: 1, dryRun: true, fetchImpl: async () => { calls += 1; return Response.json({}); } });
  await guarded("https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced");
  await assert.rejects(guarded("https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/models"), /ceiling/);
  await assert.rejects(guarded("https://evil.example/"), /destination/);
  assert.equal(calls, 1);
  const allowed = createGuardedFetch({ allowHosts: ["sandbox.dataforseo.com", "api.dataforseo.com"], maxRequests: 2, dryRun: true, fetchImpl: async () => Response.json({}) });
  await allowed("https://sandbox.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced");
  await allowed("https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/models");
  await assert.rejects(allowed("https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live"), /Dry run/);
});

test("fixture metrics and all six owner-facing report groups match without answer text", async () => {
  const observations = JSON.parse(await readFile(fixtureDir + "observations.json", "utf8"));
  for (const observation of observations) {
    if (observation.arm !== "dfs_queued") continue;
    observation.collectionEligible = observation.posted === true && observation.accepted === true;
    observation.collectionCompleted = observation.collectionEligible && observation.collectMinutes != null;
    if (!observation.collectionCompleted) { delete observation.collectMinutes; continue; }
    observation.postedAt = 0;
    observation.resultAt = Number(observation.collectMinutes) * 60_000;
    delete observation.collectMinutes;
  }
  const answers = (await readFile(fixtureDir + "answers.jsonl", "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const metrics = computeMetrics(observations, answers, [{ name: "Offcult", domain: "offcult.in" }]);
  const expected = JSON.parse(await readFile(fixtureDir + "expected-summary.json", "utf8"));
  const projection = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { answered: value.answered, indiaAcceptance: value.indiaAcceptance, aiOverviewPresence: value.aiOverviewPresence, providerCostUsd: value.providerCostUsd, parserAgreement: value.parserAgreement, latencyMs: value.latencyMs }]));
  assert.deepEqual(projection, expected);
  assert.equal(Object.keys(metrics).length, 12);
  assert.equal(metrics["dfs_queued:chatgpt"].answered.rate, 1);
  assert.equal(metrics["dfs_queued:chatgpt"].indiaAcceptance.count, 2);
  assert.equal(metrics["dfs_queued:chatgpt"].parserAgreement.rate, 1);
  assert.deepEqual(metrics["dfs_queued:chatgpt"].latencyMs, { p50: null, p90: null, max: null });
  assert.deepEqual(metrics["dfs_queued:chatgpt"].queuedLatencyMinutes, { p50: 1, p90: 1, max: 1 });
  assert.deepEqual(metrics["dfs_queued:chatgpt"].collectedBy10Minutes, { count: 2, total: 2, rate: 1 });
  const markdown = renderSummaryMarkdown(metrics);
  const expectedGroups = [
    "## 1. India location support",
    "## 2. AI Overview presence and async refunds",
    "## 3. Answer fidelity, extraction, and cross-arm agreement",
    "## 4. Latency and queued collection",
    "## 5. Failure modes",
    "## 6. Cost vs price table (USD)",
  ];
  for (const heading of expectedGroups) assert.ok(markdown.includes(heading), `missing report group: ${heading}`);
  const assertEveryMetricCell = (heading: string, column: string, expected: (value: any) => unknown) => {
    const start = markdown.indexOf(heading);
    const next = markdown.indexOf("\n## ", start + heading.length);
    const section = markdown.slice(start, next === -1 ? undefined : next);
    const lines = section.split(/\r?\n/);
    const header = lines.find((line) => line.startsWith("| Arm |"))?.split("|").map((item) => item.trim()) ?? [];
    const columnIndex = header.indexOf(column);
    assert.ok(columnIndex > 0, `missing column ${column} in ${heading}`);
    for (const value of Object.values(metrics)) {
      const row = lines.find((line) => line.startsWith(`| ${value.arm} | ${value.engine} |`));
      assert.ok(row, `missing ${value.arm}:${value.engine} row in ${heading}`);
      const actual = row!.split("|").map((item) => item.trim())[columnIndex];
      assert.equal(actual, String(expected(value)), `${value.arm}:${value.engine} ${column}`);
    }
  };
  const formatRate = (item: { total: number; count: number; rate: number | null }) => item.total
    ? `${item.count} of ${item.total} (${((item.rate ?? 0) * 100).toFixed(1)}%)`
    : "0 of 0 (n/a)";
  const formatNumber = (item: number | null | undefined, digits = 2) => Number.isFinite(item) ? Number(item).toFixed(digits) : "n/a";
  const formatHistogram = (item: Record<string, number>) => Object.keys(item).length
    ? Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}: ${count}`).join(", ")
    : "none";

  for (const [column, metric] of [
    ["Accepted / posted", "indiaAcceptance"],
    ["Echoed location 2356 / accepted", "echoedIndiaLocation"],
    [".in heuristic / answered", "indiaDomainHeuristic"],
  ]) assertEveryMetricCell(expectedGroups[0], column, (value) => formatRate(value[metric]));
  assertEveryMetricCell(expectedGroups[0], "Rejected task_post entries", (value) => value.rejectedTasks);
  assertEveryMetricCell(expectedGroups[0], "Rejected status codes", (value) => formatHistogram(value.rejectedStatusCodes));

  assertEveryMetricCell(expectedGroups[1], "AIO present / valid SERPs", (value) => formatRate(value.aiOverviewPresence));
  assertEveryMetricCell(expectedGroups[1], "Capture modes", (value) => formatHistogram(value.aioCaptureModes));
  assertEveryMetricCell(expectedGroups[1], "Queued Google refunds (< $0.0012) / accepted queued Google tasks", (value) => formatRate(value.asyncRefundObserved));
  const queuedGoogle = observations.filter((observation: any) => observation.arm === "dfs_queued" && observation.engine === "google_ai_overview" && observation.posted && observation.accepted);
  assert.deepEqual(metrics["dfs_queued:google_ai_overview"].asyncRefundObserved, {
    count: queuedGoogle.filter((observation: any) => observation.costUsd !== null && observation.costUsd !== undefined && observation.costUsd !== "" && Number.isFinite(Number(observation.costUsd)) && Number(observation.costUsd) < 0.0012).length,
    total: queuedGoogle.length,
    rate: queuedGoogle.filter((observation: any) => observation.costUsd !== null && observation.costUsd !== undefined && observation.costUsd !== "" && Number.isFinite(Number(observation.costUsd)) && Number(observation.costUsd) < 0.0012).length / queuedGoogle.length,
  });
  assert.deepEqual(metrics["dfs_live:google_ai_overview"].asyncRefundObserved, { count: 0, total: 0, rate: null });

  for (const [column, metric] of [
    ["Answered", "answered"],
    ["Empty answers", "emptyAnswer"],
    ["Offcult mentioned", "offcultMention"],
    ["Branded mention", "brandedMention"],
    ["Non-branded mention", "nonBrandedMention"],
    ["Citation coverage", "citationCoverage"],
    ["Parser agreement", "parserAgreement"],
  ]) assertEveryMetricCell(expectedGroups[2], column, (value) => formatRate(value[metric]));
  assertEveryMetricCell(expectedGroups[2], "Mean competitors", (value) => formatNumber(value.meanCompetitorsNamed));
  assertEveryMetricCell(expectedGroups[2], "Mean citations", (value) => formatNumber(value.meanCitations));
  assertEveryMetricCell(expectedGroups[2], "Median answer chars", (value) => formatNumber(value.medianAnswerLength, 0));
  assertEveryMetricCell(expectedGroups[2], "Cross-arm Offcult agreement", (value) => value.crossArmAgreement ? formatRate(value.crossArmAgreement.mentioned) : "n/a (current baseline)");
  assertEveryMetricCell(expectedGroups[2], "Citation-domain Jaccard mean (paired questions)", (value) => value.crossArmAgreement
    ? `${formatNumber(value.crossArmAgreement.citationDomainJaccardMean, 3)} (${value.crossArmAgreement.mentioned.total} paired questions)`
    : "n/a (current baseline)");

  assertEveryMetricCell(expectedGroups[3], "Live request wall p50 / p90 / max (ms)", (value) => `${formatNumber(value.latencyMs.p50, 0)} / ${formatNumber(value.latencyMs.p90, 0)} / ${formatNumber(value.latencyMs.max, 0)}`);
  assertEveryMetricCell(expectedGroups[3], "Queued post-to-result p50 / p90 / max (min)", (value) => `${formatNumber(value.queuedLatencyMinutes.p50)} / ${formatNumber(value.queuedLatencyMinutes.p90)} / ${formatNumber(value.queuedLatencyMinutes.max)}`);
  assertEveryMetricCell(expectedGroups[3], "Collected by 10 min / eligible accepted queued tasks", (value) => formatRate(value.collectedBy10Minutes));
  assertEveryMetricCell(expectedGroups[3], "Collected by 30 min / eligible accepted queued tasks", (value) => formatRate(value.collectedBy30Minutes));

  assertEveryMetricCell(expectedGroups[4], "Observation states", (value) => formatHistogram(value.states));
  assertEveryMetricCell(expectedGroups[4], "provider_failure.kind", (value) => formatHistogram(value.failureModes));
  assertEveryMetricCell(expectedGroups[4], "DataForSEO status codes", (value) => formatHistogram(value.statusCodes));
  assertEveryMetricCell(expectedGroups[4], "Rejected task_post entries", (value) => value.rejectedTasks);
  assertEveryMetricCell(expectedGroups[4], "No-results", (value) => value.noResults);
  assertEveryMetricCell(expectedGroups[4], "Ambiguous dispatches", (value) => value.ambiguousDispatches);

  assertEveryMetricCell(expectedGroups[5], "Provider cost sum", (value) => formatNumber(value.providerCostUsd.sum, 4));
  assertEveryMetricCell(expectedGroups[5], "Provider cost mean", (value) => formatNumber(value.providerCostUsd.mean, 4));
  assertEveryMetricCell(expectedGroups[5], "Known / unknown costs", (value) => `${value.providerCostUsd.known} / ${value.providerCostUsd.unknown}`);
  assertEveryMetricCell(expectedGroups[5], "Price-table expected", (value) => formatNumber(value.priceTableUsd.expected, 4));
  assertEveryMetricCell(expectedGroups[5], "Provider / price ratio", (value) => formatNumber(value.priceTableUsd.ratio, 3));
  assertEveryMetricCell(expectedGroups[5], "OpenRouter usage.cost", (value) => formatNumber(value.openRouterUsageUsd, 4));
  assertEveryMetricCell(expectedGroups[5], "Bright Data price-table cost", (value) => formatNumber(value.brightDataPriceTableUsd, 4));
  assertEveryMetricCell(expectedGroups[5], "Projected 30 questions (engine)", (value) => formatNumber(value.projected30QuestionEngineUsd, 4));
  assertEveryMetricCell(expectedGroups[5], "Projected daily ×30 (engine)", (value) => formatNumber(value.projectedMonthlyDailyEngineUsd, 4));
  assert.ok(markdown.includes("### Per-arm projection for the configured engine set"));
  assert.equal(metrics["dfs_queued:chatgpt"].projectedEngineCount, 3);
  assert.equal(metrics["dfs_queued:chatgpt"].projectedPricedEngineCount, 3);
  assert.equal(metrics["dfs_queued:chatgpt"].projected30QuestionScanUsd, 0.09);
  assert.ok(markdown.includes("| dfs_queued | 3 | 3 of 3 | 0.0900 | 2.7000 |"));
  assert.match(markdown, /DataForSEO balance delta \(before − after\): \$[^;]+; summed DataForSEO task costs: \$/);
  for (const answer of answers) assert.equal(markdown.includes(answer.answerText), false);
});

test("metrics use billed queued refunds, valid SERPs, AIO cross-arm matching, and posted-to-result collection time", () => {
  const observations = [
    { id: "queued-0", arm: "dfs_queued", engine: "google_ai_overview", questionIndex: 0, posted: true, accepted: true, collectionEligible: true, collectionCompleted: true, validSerp: true, aioPresent: true, costUsd: null, postedAt: 0, resultAt: 2 * 60_000 },
    { id: "queued-1", arm: "dfs_queued", engine: "google_ai_overview", questionIndex: 1, posted: true, accepted: true, collectionEligible: true, collectionCompleted: true, validSerp: false, aioPresent: true, costUsd: undefined, postedAt: 0, resultAt: 9 * 60_000 },
    { id: "queued-2", arm: "dfs_queued", engine: "google_ai_overview", questionIndex: 2, posted: true, accepted: true, collectionEligible: true, collectionCompleted: true, validSerp: true, aioPresent: false, costUsd: 0.0011, postedAt: 0, resultAt: 29 * 60_000 },
    { id: "queued-3", arm: "dfs_queued", engine: "google_ai_overview", questionIndex: 3, posted: true, accepted: true, collectionEligible: true, collectionCompleted: true, validSerp: false, aioPresent: false, costUsd: 0.0012, postedAt: 0, resultAt: 31 * 60_000 },
    { id: "queued-4", arm: "dfs_queued", engine: "google_ai_overview", questionIndex: 4, posted: true, accepted: true, collectionEligible: true, collectionCompleted: false, state: "failed", failureKind: "dataforseo_unavailable", statusCode: 40101, validSerp: false, aioPresent: false, costUsd: null },
    { id: "queued-5", arm: "dfs_queued", engine: "google_ai_overview", questionIndex: 5, posted: true, accepted: true, collectionEligible: true, collectionCompleted: true, state: "valid_no_aio", noResults: true, statusCode: 40501, validSerp: false, aioPresent: false, costUsd: 0, postedAt: 0, resultAt: 35 * 60_000 },
    { id: "live-0", arm: "dfs_live", engine: "google_ai_overview", questionIndex: 0, validSerp: true, costUsd: 0.001, collectMinutes: 3 },
    { id: "live-failed", arm: "dfs_live", engine: "chatgpt", questionIndex: 1, state: "failed", failureKind: "dataforseo_unavailable", statusCode: 40101, costUsd: 0.001 },
    { id: "live-no-results", arm: "dfs_live", engine: "google_ai_overview", questionIndex: 1, state: "valid_no_aio", noResults: true, statusCode: 40501, validSerp: false, costUsd: 0 },
    { id: "current-0", arm: "current", engine: "aio", questionIndex: 0, validSerp: true, aioPresent: true, collectMinutes: 4 },
  ];
  const answers = [
    { observationId: "queued-0", brandMentioned: true, citations: [{ domain: "queued.example" }] },
    { observationId: "live-0", brandMentioned: false, citations: [{ domain: "current.example" }] },
    { observationId: "current-0", brandMentioned: false, citations: [{ domain: "current.example" }] },
  ];
  const metrics = computeMetrics(observations, answers);

  assert.deepEqual(metrics["dfs_queued:google_ai_overview"].asyncRefundObserved, { count: 2, total: 6, rate: 1 / 3 });
  assert.equal(metrics["dfs_queued:google_ai_overview"].statusCodes[40101], 1);
  assert.equal(metrics["dfs_queued:google_ai_overview"].statusCodes[40501], 1);
  assert.equal(metrics["dfs_queued:google_ai_overview"].failureModes.dataforseo_unavailable, 1);
  assert.equal(metrics["dfs_live:chatgpt"].statusCodes[40101], 1);
  assert.equal(metrics["dfs_live:google_ai_overview"].statusCodes[40501], 1);
  assert.deepEqual(metrics["dfs_live:google_ai_overview"].asyncRefundObserved, { count: 0, total: 0, rate: null });
  assert.deepEqual(metrics["dfs_queued:google_ai_overview"].aiOverviewPresence, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(metrics["dfs_queued:google_ai_overview"].crossArmAgreement.mentioned, { count: 0, total: 1, rate: 0 });
  assert.equal(metrics["dfs_queued:google_ai_overview"].crossArmAgreement.citationDomainJaccardMean, 0);
  assert.deepEqual(metrics["dfs_live:google_ai_overview"].crossArmAgreement.mentioned, { count: 1, total: 1, rate: 1 });
  assert.equal(metrics["dfs_live:google_ai_overview"].crossArmAgreement.citationDomainJaccardMean, 1);
  assert.deepEqual(metrics["dfs_queued:google_ai_overview"].queuedLatencyMinutes, { p50: 29, p90: 35, max: 35 });
  assert.deepEqual(metrics["dfs_queued:google_ai_overview"].collectedBy10Minutes, { count: 2, total: 6, rate: 1 / 3 });
  assert.deepEqual(metrics["dfs_queued:google_ai_overview"].collectedBy30Minutes, { count: 3, total: 6, rate: 0.5 });
  assert.deepEqual(metrics["dfs_live:google_ai_overview"].queuedLatencyMinutes, { p50: null, p90: null, max: null });
  assert.deepEqual(metrics["dfs_live:google_ai_overview"].collectedBy10Minutes, { count: 0, total: 0, rate: null });
  const markdown = renderSummaryMarkdown(metrics);
  assert.match(markdown, /40101: 1/);
  assert.match(markdown, /40501: 1/);
});

test("rejects --out paths through a symlink or junction into the repository", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "f02-output-link-"));
  const repository = path.join(temporary, "repository");
  const outside = path.join(temporary, "outside");
  const linkedParent = path.join(outside, "repo-link");
  await mkdir(repository, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await symlink(repository, linkedParent, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => assertEnvironment(
        { PGHOST: "127.0.0.1", PGDATABASE: "aeovis_live_qa" },
        repository,
        { out: path.join(linkedParent, "answers") },
      ),
      /outside the repository/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("output creation returns the real outside path and refuses an existing target", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "f02-output-real-"));
  const repository = path.join(temporary, "repository");
  const outside = path.join(temporary, "outside");
  const output = path.join(outside, "answers");
  await mkdir(repository, { recursive: true });
  try {
    const realOutput = await createPrivateOutputDirectory(output, repository);
    assert.equal(realOutput, output);
    await assert.rejects(createPrivateOutputDirectory(output, repository), /run id already exists/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const capturedConsoleMethods = [
  "assert", "debug", "dir", "dirxml", "error", "group", "groupCollapsed",
  "info", "log", "table", "trace", "warn",
] as const;
type CapturedConsoleMethod = (typeof capturedConsoleMethods)[number];

function captureConsoleOutput() {
  const output: string[] = [];
  const saved = new Map<CapturedConsoleMethod, PropertyDescriptor | undefined>();
  for (const method of capturedConsoleMethods) {
    const descriptor = Object.getOwnPropertyDescriptor(console, method);
    saved.set(method, descriptor);
    Object.defineProperty(console, method, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value: (...args: unknown[]) => {
        output.push(args.map((value) => typeof value === "string" ? value : "[non-string]").join(" "));
      },
    });
  }
  return {
    output,
    restore() {
      for (const method of capturedConsoleMethods) {
        const descriptor = saved.get(method);
        if (descriptor) Object.defineProperty(console, method, descriptor);
        else Reflect.deleteProperty(console, method);
      }
    },
  };
}

function currentTextEngine(
  name: string,
  providerProbe: (query: string, options: { durableDispatch?: boolean; stats?: Record<string, unknown> }) => Promise<any>,
) {
  return {
    probe: async (
      query: { text: string },
      brand: string,
      brandAliases: string[],
      brandDomain: string | null,
      competitors: unknown[],
      stats: Record<string, unknown>,
      options: { durableDispatch?: boolean } = {},
    ) => probeTextEngine(
      { name, probe: providerProbe },
      query,
      brand,
      brandAliases,
      brandDomain,
      competitors,
      stats,
      options,
    ),
  };
}

test("current-provider ChatGPT probe uses durable dispatch and performs one counted fetch", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  const capture = captureConsoleOutput();
  const logDuringCapture = console.log;
  const warnDuringCapture = console.warn;
  const sentinel = "F02_CURRENT_PROMPT_SENTINEL_CHATGPT";
  let calls = 0;
  process.env.OPENAI_API_KEY = "test-only";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("temporary upstream failure", { status: 503 });
  };
  try {
    const result = await probeCurrentProviderOnce(
      currentTextEngine("chatgpt", probeChatGpt),
      { text: sentinel },
      "Offcult",
      [],
      "offcult.in",
      [],
      {},
    );
    assert.ok(result.error);
    assert.equal(calls, 1);
    assert.equal(capture.output.some((line) => line.includes(sentinel)), false);
    assert.equal(console.log, logDuringCapture);
    assert.equal(console.warn, warnDuringCapture);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
    globalThis.fetch = previousFetch;
    capture.restore();
  }
});

test("current-provider Perplexity answer and citation failures do not log the prompt", async () => {
  const previousKey = process.env.PERPLEXITY_API_KEY;
  const previousFetch = globalThis.fetch;
  const capture = captureConsoleOutput();
  const sentinel = "F02_CURRENT_PROMPT_SENTINEL_PERPLEXITY";
  let mode: "answer-failed" | "citation-failed" = "answer-failed";
  let calls = 0;
  process.env.PERPLEXITY_API_KEY = "test-only";
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/chat/completions")) {
      if (mode === "answer-failed") return new Response("stubbed upstream failure", { status: 503 });
      return Response.json({
        model: "sonar-pro",
        choices: [{ message: { content: "A synthetic provider answer" } }],
        usage: { cost: 0, prompt_tokens: 1, completion_tokens: 1 },
      });
    }
    if (url.endsWith("/search")) {
      if (mode === "citation-failed") return new Response("stubbed upstream failure", { status: 503 });
      return Response.json({ results: [] });
    }
    throw new Error("Unexpected stub destination");
  };
  const engine = currentTextEngine("perplexity", probePerplexity);
  try {
    for (const failureMode of ["answer-failed", "citation-failed"] as const) {
      mode = failureMode;
      calls = 0;
      await probeCurrentProviderOnce(
        engine,
        { text: sentinel },
        "Offcult",
        [],
        "offcult.in",
        [],
        {},
      );
      assert.equal(calls, 2);
      assert.equal(capture.output.some((line) => line.includes(sentinel)), false);
    }
  } finally {
    if (previousKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
    capture.restore();
  }
});

test("current-provider pipeline suppresses empty-answer prompt logs", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  const capture = captureConsoleOutput();
  const logDuringCapture = console.log;
  const sentinel = "F02_CURRENT_PROMPT_SENTINEL_EMPTY";
  let calls = 0;
  process.env.OPENAI_API_KEY = "test-only";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      model: "gpt-4o-mini",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    });
  };
  try {
    const result = await probeCurrentProviderOnce(
      currentTextEngine("chatgpt", probeChatGpt),
      { text: sentinel },
      "Offcult",
      [],
      "offcult.in",
      [],
      {},
    );
    assert.equal(result.error, "empty_answer");
    assert.equal(calls, 1);
    assert.equal(capture.output.some((line) => line.includes(sentinel)), false);
    assert.equal(console.log, logDuringCapture);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
    globalThis.fetch = previousFetch;
    capture.restore();
  }
});
