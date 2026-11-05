#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { aiAnswerUsd, llmResponseUsd } from "../../src/shared/ai-visibility-pricing.ts";
import { serpQueryUsd } from "../../src/lib/pricing/perceev.ts";
import { probeTextEngine, resolveEnabledEngines } from "../../src/lib/scoring/enginePipeline.js";
import { getBrandAliases } from "../../src/lib/scoring/aliases.js";
import { extractBrandDomain } from "../../src/lib/scoring/citations.js";
import { createProbeDispatchStore, dispatchIdentity } from "../../src/lib/db/probeDispatch.js";
import { DATAFORSEO_SANDBOX_BASE, dataforseoPost } from "../../src/lib/providers/dataforseo/core.ts";
import { fetchAiTrackingLiveAnswer, fetchAiTrackingTaskResult, postAiTrackingTasks } from "../../src/lib/providers/dataforseo/ai-tracking.ts";
import { fetchLlmResponse } from "../../src/lib/providers/dataforseo/ai.ts";
import { resolveLatestLlmModelName } from "../../src/lib/providers/dataforseo/llm-models.ts";
import { fetchUserData } from "../../src/lib/providers/dataforseo/appendix.ts";
import { parseDataforseoAnswer, parseLlmResponseAnswer } from "../../src/lib/providers/dataforseo/dataforseoEvidence.ts";
import { assertEnvironment, computeMetrics, createGuardedFetch, createPrivateOutputDirectory, estimatePlan, loadPanel, parseArgs, planArms, probeCurrentProviderOnce, renderSummaryMarkdown } from "../../src/lib/providers/dataforseo/bakeoffLib.ts";

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error("Missing --panel");
  process.exit(2);
}
let args;
try { args = parseArgs(argv); }
catch (error) { console.error(error instanceof Error ? error.message : "Invalid arguments"); process.exit(error?.exitCode ?? 2); }

async function selfTest() {
  let paidRequests = 0;
  const guarded = createGuardedFetch({
    allowHosts: ["sandbox.dataforseo.com", "api.dataforseo.com"],
    maxRequests: 2,
    dryRun: true,
    fetchImpl: async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname !== "sandbox.dataforseo.com" && !url.pathname.endsWith("/models")) paidRequests += 1;
      return Response.json({ status_code: 20000, tasks: [{ status_code: 20000, result: [] }] });
    },
  });
  await guarded("https://sandbox.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced", { method: "POST" });
  await guarded("https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/models");
  assert.equal(paidRequests, 0);
  assert.equal(guarded.requestCount, 2);
  console.log("PASS dry-run self-test; 0 paid requests");
}

function allowedProviderHosts(env) {
  const hosts = ["api.dataforseo.com", "sandbox.dataforseo.com"];
  const modelBase = env.LLM_BASE_URL || env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  try { hosts.push(new URL(modelBase).hostname); } catch { throw new Error("LLM_BASE_URL must be an absolute URL"); }
  if (env.BRIGHTDATA_API_KEY) hosts.push("api.brightdata.com");
  if (env.OPENAI_API_KEY) hosts.push("api.openai.com");
  if (env.PERPLEXITY_API_KEY) hosts.push("api.perplexity.ai");
  return [...new Set(hosts)];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function apiEngine(engine) { return engine === "aio" ? "google_ai_overview" : engine; }
function dbEngine(engine) { return engine === "google_ai_overview" ? "aio" : engine; }
function answerFailure(error) {
  return { kind: error?.name === "AmbiguousCallError" ? "dispatch_unknown" : "provider_error", code: error?.code ?? null };
}
function extractWithExistingPipeline(engine, prompt, text, citations, brand, aliases, domain, competitors, cost) {
  const refs = citations.map((citation) => ({ href: citation.url, title: citation.title ?? "", source: "dataforseo" }));
  return probeTextEngine({ name: engine, probe: async () => ({ text, citations: citations.map((item) => item.url), references: refs, cost, answer_present: Boolean(text.trim()) }) }, { text: prompt }, brand, aliases, domain, competitors, {}, {});
}
function reviewSampleMarkdown(answerRows) {
  const groups = new Map();
  for (const answer of answerRows.filter((item) => item.answerText?.trim())) {
    const key = `${answer.arm}:${answer.engine}`;
    const rows = groups.get(key) ?? [];
    rows.push(answer);
    groups.set(key, rows);
  }
  const lines = ["# Private manual answer review", "", "Mark each item correct or incorrect in the decision record. Do not copy answer text into the repository."];
  for (const [key, items] of groups) {
    lines.push("", `## ${key}`);
    const sample = [...items].sort(() => Math.random() - 0.5).slice(0, 10);
    for (const item of sample) {
      lines.push("", `### Question ${item.questionIndex + 1}`, `- Offcult mention detected: ${item.brandMentioned ? "yes" : "no"}`, `- Competitors named: ${item.competitorsNamed}`, `- Citations: ${item.citations.length}`, "", item.answerText);
    }
  }
  return lines.join("\n") + "\n";
}

async function main() {
  if (args.selfTest) return selfTest();
  assertEnvironment(process.env, process.cwd(), args);
  if (!args.runId) throw Object.assign(new Error("Missing --run-id"), { exitCode: 2 });
  if (!args.out) throw Object.assign(new Error("Missing --out"), { exitCode: 2 });
  if (args.runId.length < 8) throw Object.assign(new Error("Invalid --run-id"), { exitCode: 2 });
  const panel = await loadPanel(args.panel);
  const plan = planArms(panel, args);
  const estimatedUsd = estimatePlan(plan);
  if (estimatedUsd > args.maxSpendUsd) throw Object.assign(new Error("Price-table estimate exceeds --max-spend-usd"), { exitCode: 2 });
  const brightDataUnitUsd = args.arms.includes("current") ? serpQueryUsd("brightdata", 1) : null;
  if (args.dryRun) {
    const guarded = createGuardedFetch({ allowHosts: allowedProviderHosts(process.env), maxRequests: args.maxRequests, dryRun: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = guarded;
    try {
      const env = { ...process.env, DATAFORSEO_BASE_URL: DATAFORSEO_SANDBOX_BASE };
      const sample = panel.prompts[0].text;
      for (const engine of ["chatgpt", "gemini", "google_ai_overview"]) {
        const path = engine === "google_ai_overview" ? "/v3/serp/google/organic/live/advanced" : `/v3/ai_optimization/${engine === "chatgpt" ? "chat_gpt" : engine}/llm_scraper/live/advanced`;
        await dataforseoPost(path, [{ keyword: sample, location_code: 2356, language_code: panel.context.language }], { env, baseUrl: DATAFORSEO_SANDBOX_BASE, fetchImpl: guarded });
      }
      await resolveLatestLlmModelName("perplexity", { env, fetchImpl: guarded, cache: new Map() });
      console.log(JSON.stringify({ dryRun: true, planCount: plan.length, estimatedUsd, requestCount: guarded.requestCount, paidRequests: 0 }));
    } finally { globalThis.fetch = originalFetch; }
    return;
  }
  const out = await createPrivateOutputDirectory(args.out, process.cwd());
  const pool = new pg.Pool({ max: 12 });
  const q = (sql, values = []) => pool.query(sql, values);
  async function rpc(name, values) {
    const entries = Object.entries(values);
    const result = await q(`select ${name}(${entries.map(([key], index) => `${key}=>$${index + 1}`).join(",")}) result`, entries.map(([, value]) => value && typeof value === "object" ? JSON.stringify(value) : value));
    return { data: result.rows[0].result, error: null };
  }
  const store = createProbeDispatchStore({ rpc });
  const maxRequests = args.maxRequests;
  const budgetScope = `bakeoff:${args.runId}`;
  const startedAt = new Date().toISOString();
  const balanceBefore = (await fetchUserData())?.money?.balance ?? null;
  const rows = plan.map((item) => {
    const engine = dbEngine(item.engine);
    const identity = item.arm === "current" ? dispatchIdentity(engine, process.env) : null;
    return {
      id: crypto.randomUUID(), job_id: null, purpose: "canary", engine,
      query: panel.prompts[item.questionIndex].text,
      context: { budget_scope: budgetScope, max_requests: maxRequests, request_units: item.requestUnits, arm: item.arm, question_index: item.questionIndex },
      config_version: identity?.config_version ?? "f02-dataforseo-bakeoff-v1",
      circuit_key: identity?.circuit_key ?? crypto.createHash("sha256").update(`dataforseo:${engine}`).digest("hex"),
      deadline_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
  });
  await store.seed(rows);
  const rowByPlan = new Map(plan.map((item, index) => [`${item.arm}:${item.engine}:${item.questionIndex}`, rows[index]]));
  const observations = [];
  const answers = [];
  const activeLeases = new Map();
  let renewalTimer = null;
  const guarded = createGuardedFetch({ allowHosts: allowedProviderHosts(process.env), maxRequests: args.maxRequests, dryRun: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = guarded;
  const brand = "Offcult";
  const brandAliases = getBrandAliases(brand, panel.context.website || "offcult.in");
  const brandDomain = extractBrandDomain(panel.context.website || "offcult.in");
  const competitors = args.competitors;
  const manifestRows = [];

  function ensureLeaseRenewal() {
    renewalTimer ??= setInterval(async () => {
      for (const lease of activeLeases.values()) {
        try {
          const renewed = await store.renew(lease.row.id, lease.token, lease.leaseSeconds);
          if (renewed !== true) lease.renewalFailed = true;
        } catch { lease.renewalFailed = true; }
      }
    }, 60_000);
  }

  async function claim(item) {
    const row = rowByPlan.get(`${item.arm}:${item.engine}:${item.questionIndex}`);
    const reserve = item.arm === "dfs_live" ? aiAnswerUsd(item.engine === "google_ai_overview" ? "google_ai_overview" : item.engine, "live") : item.arm === "dfs_model" ? llmResponseUsd("perplexity", true) : item.arm === "current" ? args.reserveUsd : aiAnswerUsd(item.engine === "google_ai_overview" ? "google_ai_overview" : item.engine, "queued");
    const result = await store.claim(row.id, { reserve, scanCap: args.maxSpendUsd, leaseSeconds: item.arm === "dfs_queued" || item.arm === "dfs_live" ? 180 : 120 });
    if (!result?.granted) {
      manifestRows.push({ id: row.id, arm: item.arm, engine: item.engine, questionIndex: item.questionIndex, state: "blocked", reason: result?.reason ?? "claim_refused", attemptCount: 0, costUsd: 0, statusCode: null });
      observations.push({ id: row.id, arm: item.arm, engine: item.engine, questionIndex: item.questionIndex, state: "blocked", posted: false, accepted: false, costUsd: 0 });
      return null;
    }
    const lease = { row, token: result.lease_token, attemptNo: result.attempt_no, item, leaseSeconds: item.arm === "dfs_queued" || item.arm === "dfs_live" ? 180 : 120, startedAt: Date.now(), renewalFailed: false };
    activeLeases.set(row.id, lease);
    ensureLeaseRenewal();
    return lease;
  }

  async function record(lease, answer, error = null, postedAtMs = null, collectedAtMs = null, collectionCompleted = false) {
    const resultAtMs = collectionCompleted ? collectedAtMs ?? Date.now() : null;
    const item = lease.item;
    const reportedCost = Number.isFinite(answer?.costUsd) ? answer.costUsd : Number.isFinite(answer?.billing?.costUsd) ? answer.billing.costUsd : Number.isFinite(answer?.cost) ? answer.cost : null;
    const providerCost = item.arm === "current" && item.engine === "aio" ? null : reportedCost;
    const text = answer?.answerText ?? answer?.text ?? "";
    const citations = answer?.citations ?? [];
    const processed = item.arm === "current" ? answer : await extractWithExistingPipeline(dbEngine(item.engine), lease.row.query, text, citations, brand, brandAliases, brandDomain, competitors, providerCost);
    const brightDataPriceUsd = answer?.brightDataPriceUsd ?? (item.arm === "current" && item.engine === "aio" ? brightDataUnitUsd : null);
    const settlementCost = item.arm === "current" && item.engine === "aio" ? brightDataPriceUsd : providerCost;
    const result = {
      engine: dbEngine(item.engine), prompt: lease.row.query,
      answer_present: Boolean(text.trim()), text,
      brand_mentioned_in_text: Boolean(processed?.brand_mentioned_in_text),
      brand_cited: Boolean(processed?.brand_cited),
      brands: processed?.brands ?? [], citations,
      cost: settlementCost,
      provider_failure: error ? answerFailure(error) : null,
    };
    let state = error ? "failed" : item.engine === "google_ai_overview" && !text.trim() || item.engine === "aio" && answer?.serp_state === "valid_serp" && answer?.aio_present === false ? "valid_no_aio" : "answered";
    const finish = await store.finish(lease.row.id, lease.token, result, { state, failure: result.provider_failure, next_at: null });
    // A result that arrives after its lease expired is already recorded as ambiguous; count it and keep running.
    if (finish?.accepted === false) state = "ambiguous";
    const duration = Date.now() - lease.startedAt;
    const tablePrice = item.arm === "current" ? brightDataPriceUsd : item.arm === "dfs_model" ? llmResponseUsd("perplexity", true) : aiAnswerUsd(item.engine === "google_ai_overview" ? "google_ai_overview" : item.engine, item.arm === "dfs_live" ? "live" : "queued");
    const collectMinutes = postedAtMs === null || resultAtMs === null ? null : Math.max(0, (resultAtMs - postedAtMs) / 60_000);
    const validSerp = answer?.validSerp ?? (item.engine === "aio"
      ? answer?.serp_state === "valid_serp"
      : item.engine === "google_ai_overview" && answer?.statusCode === 20000 && answer?.noResults !== true);
    const metricRow = { id: lease.row.id, arm: item.arm, engine: item.engine, questionIndex: item.questionIndex, state, posted: item.arm === "current" ? false : answer?.posted !== false, accepted: item.arm === "current" ? false : answer?.accepted !== false, echoedLocation: answer?.locationCode === 2356, validSerp: Boolean(validSerp), aioPresent: Boolean(answer?.aioPresent ?? answer?.aio_present), asyncRefund: Boolean(answer?.asyncRefund), noResults: Boolean(answer?.noResults), aioCaptureMode: answer?.aio_capture_mode ?? answer?.provenance?.aio_capture_mode ?? null, latencyMs: duration, collectionEligible: postedAtMs !== null, collectionCompleted, postedAt: postedAtMs === null ? null : new Date(postedAtMs).toISOString(), resultAt: resultAtMs === null ? null : new Date(resultAtMs).toISOString(), collectMinutes, costUsd: providerCost, priceUsd: tablePrice, failureKind: result.provider_failure?.kind ?? null, statusCode: answer?.statusCode ?? null, rejectedTask: Boolean(answer?.rejectedTask || answer?.accepted === false), ambiguous: result.provider_failure?.kind === "dispatch_unknown", openRouterCostUsd: answer?.openRouterCostUsd ?? (answer?.cost_source === "gateway" ? reportedCost : null), brightDataPriceUsd };
    observations.push(metricRow);
    answers.push({ observationId: lease.row.id, arm: item.arm, engine: item.engine, questionIndex: item.questionIndex, answerText: text, citations, brandMentioned: Boolean(processed?.brand_mentioned_in_text), branded: Boolean(processed?.is_branded_query), competitorsNamed: (processed?.competitors_found_in_text ?? []).length, extractedMentioned: Boolean(processed?.brand_mentioned_in_text) });
    manifestRows.push({ id: lease.row.id, arm: item.arm, engine: item.engine, questionIndex: item.questionIndex, state, attemptCount: lease.attemptNo, costUsd: providerCost, costSource: providerCost == null ? "unknown" : "provider", latencyMs: duration, collectionEligible: metricRow.collectionEligible, collectionCompleted, postedAt: metricRow.postedAt, resultAt: metricRow.resultAt, collectMinutes, statusCode: answer?.statusCode ?? null, reason: result.provider_failure?.kind ?? null, provenance: answer?.provenance ?? null });
    activeLeases.delete(lease.row.id);
  }

  try {
    for (const arm of args.arms) {
      const armItems = plan.filter((item) => item.arm === arm);
      if (arm === "dfs_queued") {
        const byEngine = Map.groupBy(armItems, (item) => item.engine);
        for (const [engine, items] of byEngine) {
          const leases = (await Promise.all(items.map(claim))).filter(Boolean);
          if (!leases.length) continue;
          let response;
          try { response = await postAiTrackingTasks({ engine: apiEngine(engine), locationCode: 2356, languageCode: panel.context.language, tasks: leases.map((lease) => ({ tag: lease.row.id, prompt: lease.row.query })) }); }
          catch (error) { for (const lease of leases) await record(lease, { costUsd: null }, error); continue; }
          const postedAtMs = Date.now();
          const postedByTag = new Map(response.data.posted.map((item) => [item.tag, item.taskId]));
          for (const rejected of response.data.rejected) {
            const lease = leases.find((item) => item.row.id === rejected.tag);
            if (lease) await record(lease, { costUsd: rejected.costUsd, statusCode: rejected.statusCode, accepted: false, rejectedTask: true }, new Error("Provider rejected task"));
          }
          const pending = leases.filter((lease) => postedByTag.has(lease.row.id)).map((lease) => ({ lease, taskId: postedByTag.get(lease.row.id), postedAtMs }));
          const pollStarted = Date.now();
          for (const offset of [2, 4, 7, 10, 14, 18, 22, 26, 30]) {
            await delay(Math.max(0, offset * 60_000 - (Date.now() - pollStarted)));
            const next = [];
            for (const entry of pending) {
              if (entry.lease.renewalFailed) { await record(entry.lease, { costUsd: null }, new Error("Lease renewal failed"), entry.postedAtMs); continue; }
              let collectionCompleted = false;
              let collectedAtMs = null;
              try {
                const outcome = await fetchAiTrackingTaskResult({ engine: apiEngine(engine), taskId: entry.taskId });
                if (outcome.status === "pending") { next.push(entry); continue; }
                collectionCompleted = true;
                collectedAtMs = Date.now();
                if (outcome.status === "failed") { await record(entry.lease, { costUsd: outcome.costUsd, statusCode: outcome.statusCode }, new Error(outcome.message), entry.postedAtMs, collectedAtMs, true); continue; }
                const parsed = parseDataforseoAnswer(outcome.result, apiEngine(engine));
                await record(entry.lease, { answerText: parsed?.answerText ?? "", citations: parsed?.citations ?? [], costUsd: outcome.costUsd, statusCode: outcome.statusCode, aioPresent: Boolean(parsed?.answerText), asyncRefund: engine === "google_ai_overview" && outcome.costUsd !== null && outcome.costUsd !== undefined && Number.isFinite(Number(outcome.costUsd)) && Number(outcome.costUsd) < 0.0012, noResults: outcome.result === null, locationCode: 2356 }, null, entry.postedAtMs, collectedAtMs, true);
              } catch (error) { await record(entry.lease, { costUsd: null }, error, entry.postedAtMs, collectedAtMs, collectionCompleted); }
            }
            pending.splice(0, pending.length, ...next);
            if (!pending.length) break;
          }
          for (const entry of pending) await record(entry.lease, { costUsd: null }, new Error("Task collection window expired"), entry.postedAtMs);
        }
      } else if (arm === "current") {
        const requested = "aio,chatgpt,gemini,perplexity";
        const engines = resolveEnabledEngines({ engines: requested, allowFallback: false });
        const byName = new Map(engines.map((engine) => [engine.name, engine]));
        for (const item of armItems) {
          const engine = byName.get(item.engine);
          if (!engine) {
            const row = rowByPlan.get(`${item.arm}:${item.engine}:${item.questionIndex}`);
            manifestRows.push({ id: row.id, arm, engine: item.engine, questionIndex: item.questionIndex, state: "skipped", reason: "current_provider_not_configured", attemptCount: 0, costUsd: null });
            observations.push({ id: row.id, arm, engine: item.engine, questionIndex: item.questionIndex, state: "skipped", posted: false, accepted: false, costUsd: 0 });
            continue;
          }
          const lease = await claim(item);
          if (!lease) continue;
          try {
            const output = await probeCurrentProviderOnce(engine, { text: lease.row.query, purpose: "informational" }, brand, brandAliases, brandDomain, competitors, {});
            await record(lease, { ...output, answerText: output.text ?? "", cost: output.cost }, output.error ? new Error("Current provider returned an error outcome") : null);
          } catch (error) { await record(lease, { costUsd: null }, error); }
        }
      } else {
        for (const item of armItems) {
          const lease = await claim(item);
          if (!lease) continue;
          try {
            if (arm === "dfs_model") {
              const modelName = await resolveLatestLlmModelName("perplexity");
              const response = await fetchLlmResponse({ modelSlug: "perplexity", modelName, userPrompt: lease.row.query, webSearch: true, webSearchCountryCode: "IN" });
              const parsed = parseLlmResponseAnswer(response.data);
              await record(lease, { answerText: parsed.answerText, citations: parsed.citations, costUsd: response.billing.costUsd, statusCode: 20000, locationCode: 2356, provenance: { modelName: parsed.modelName, webSearch: parsed.webSearch, outputTokens: parsed.outputTokens, fanOutQueries: parsed.fanOutQueries } });
            } else {
              const engine = apiEngine(item.engine);
              const response = await fetchAiTrackingLiveAnswer({ engine, locationCode: 2356, languageCode: panel.context.language, task: { tag: lease.row.id, prompt: lease.row.query } });
              if (response.data.status === "failed") {
                await record(lease, { costUsd: response.billing.costUsd, statusCode: response.data.statusCode }, new Error(response.data.message));
                continue;
              }
              const parsed = parseDataforseoAnswer(response.data.result, engine);
              await record(lease, { answerText: parsed?.answerText ?? "", citations: parsed?.citations ?? [], costUsd: response.billing.costUsd, statusCode: response.data.statusCode, locationCode: 2356, aioPresent: Boolean(parsed?.answerText), noResults: response.data.result === null });
            }
          } catch (error) { await record(lease, { costUsd: null }, error); }
        }
      }
    }
    const balanceAfter = (await fetchUserData())?.money?.balance ?? null;
    const metrics = computeMetrics(observations, answers, [{ name: brand, domain: brandDomain }, ...competitors.map((name) => ({ name, domain: name }))], { balanceBeforeUsd: balanceBefore, balanceAfterUsd: balanceAfter });
    const manifest = { runId: args.runId, startedAt, finishedAt: new Date().toISOString(), arms: args.arms, maxSpendUsd: args.maxSpendUsd, maxRequests: args.maxRequests, requestCount: guarded.requestCount, estimatedUsd, balanceBeforeUsd: balanceBefore, balanceAfterUsd: balanceAfter, observations: manifestRows };
    await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await writeFile(path.join(out, "answers.jsonl"), answers.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
    await writeFile(path.join(out, "summary.json"), JSON.stringify(metrics, null, 2), { mode: 0o600 });
    await writeFile(path.join(out, "summary.md"), renderSummaryMarkdown(metrics), { mode: 0o600 });
    await writeFile(path.join(out, "review-sample.md"), reviewSampleMarkdown(answers), { mode: 0o600 });
    console.log(JSON.stringify({ runId: args.runId, observationCount: manifestRows.length, requestCount: guarded.requestCount, estimatedUsd, outputDirectory: out }));
  } finally {
    clearInterval(renewalTimer);
    globalThis.fetch = originalFetch;
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error?.exitCode === 2 ? error.message : "Bake-off failed; inspect the private output directory and loopback QA logs.");
  process.exitCode = error?.exitCode ?? 1;
});
