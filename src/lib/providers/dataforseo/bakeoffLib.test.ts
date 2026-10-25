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

test("fixture metrics equal the expected summary and markdown contains no answer text", async () => {
  const observations = JSON.parse(await readFile(fixtureDir + "observations.json", "utf8"));
  const answers = (await readFile(fixtureDir + "answers.jsonl", "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const metrics = computeMetrics(observations, answers, [{ name: "Offcult", domain: "offcult.in" }]);
  const expected = JSON.parse(await readFile(fixtureDir + "expected-summary.json", "utf8"));
  const projection = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { answered: value.answered, indiaAcceptance: value.indiaAcceptance, aiOverviewPresence: value.aiOverviewPresence, providerCostUsd: value.providerCostUsd, parserAgreement: value.parserAgreement, latencyMs: value.latencyMs }]));
  assert.deepEqual(projection, expected);
  assert.equal(Object.keys(metrics).length, 12);
  assert.equal(metrics["dfs_queued:chatgpt"].answered.rate, 1);
  assert.equal(metrics["dfs_queued:chatgpt"].indiaAcceptance.count, 2);
  assert.equal(metrics["dfs_queued:chatgpt"].parserAgreement.rate, 1);
  const markdown = renderSummaryMarkdown(metrics);
  for (const answer of answers) assert.equal(markdown.includes(answer.answerText), false);
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
