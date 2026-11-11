// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityCollection.ts
//   src/server/workflows/AiVisibilityWorkflow.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createObservationEnvelope } from "../provenance.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { extractBrandDomain } from "../scoring/citations.js";
import { probeAioDataforseo, probeTextEngine } from "../scoring/enginePipeline.js";
import {
  collectDataforseoTask,
  postDataforseoBatch,
  probeDataforseoScraper,
} from "../engines/dataforseo.ts";
import { dataforseoMarket } from "../providers/dataforseo/locations.ts";
import {
  classifyProviderFailure,
  sanitizeProviderText,
} from "../engines/providerFailure.js";
import { resultDecision } from "../db/probeDispatch.js";
import { AppError } from "../http/appError.ts";

export const QUEUED_COLLECTION_READY = true;
export const POLL_OFFSETS_MIN = [2, 4, 7, 10, 14, 18, 22, 26, 30];
export const COLLECT_WINDOW_MIN = 30;
export const TASK_GET_CONCURRENCY = 25;

const MAX_TASKS_PER_POST = 100;
const QUEUED_LEASE_SECONDS = 120;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

function timeMs(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export function nextPollAt(postedAtMs, nowMs) {
  const postedAt = Number(postedAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(postedAt) || !Number.isFinite(now)) return null;
  const offset = POLL_OFFSETS_MIN.find((minutes) => postedAt + minutes * MINUTE_MS > now);
  return offset === undefined ? null : iso(postedAt + offset * MINUTE_MS);
}

function attemptFor(row) {
  return row.attempt ||
    (row.probe_attempts || []).find((attempt) => attempt.dispatch_state === "posted") ||
    row;
}

function postedCost(row) {
  const value = Number(attemptFor(row).charged_usd);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function taskFailure(engine, query, message, statusCode, cost, taskId) {
  const error = Object.assign(new Error(message), {
    providerCode: Number.isFinite(statusCode) ? `dataforseo_${statusCode}` : undefined,
  });
  const providerFailure = classifyProviderFailure({ provider: "dataforseo", error });
  return {
    engine,
    prompt: query,
    error: sanitizeProviderText(message) || "DataForSEO task failed.",
    answer_present: false,
    cost,
    cost_source: cost === null ? null : "gateway",
    cost_state: cost === null ? "unknown_billed" : "measured",
    cost_state_detail: null,
    gateway: "dataforseo",
    measurement_method: engine === "aio" ? "google_serp" : "consumer_capture",
    provider_request_id: taskId || null,
    provider_task_id: taskId || null,
    provider_failure: providerFailure,
  };
}

function observationOptions({ row, attempt, cp, captureEvidence }) {
  const startedAt = attempt.posted_at || new Date().toISOString();
  const completedAt = new Date().toISOString();
  const captures = captureEvidence ? [captureEvidence] : [];
  return {
    resultMeta: {
      measurement_context: { ...cp.measurement_context, surface: row.engine },
      observed_location: null,
      location_verification: "unverified",
      capture_started_at: startedAt,
      capture_completed_at: completedAt,
      evidence_state: captures.length && captures.every((capture) => capture.state === "stored")
        ? "stored"
        : captures.length
          ? "incomplete"
          : "unverified",
      evidence_captures: captures,
    },
    envelope: {
      observation_id: row.id,
      attempt_id: attempt.lease_token,
      attempt_number: attempt.attempt_no,
      surface: row.engine,
      gateway: "dataforseo",
      requested_location: cp.measurement_context.country,
      language: cp.measurement_context.language,
      device: cp.measurement_context.device,
      session_policy: cp.measurement_context.session_policy,
      started_at: startedAt,
      completed_at: completedAt,
      evidence_identities: captures.map((capture) => capture.sha256).filter(Boolean),
      evidence_state: captures.length && captures.every((capture) => capture.state === "stored")
        ? "stored"
        : captures.length
          ? "incomplete"
          : "unverified",
    },
  };
}

async function postProcessedResult({
  row,
  attempt,
  rawTask,
  cp,
  env,
  aliases,
  domain,
  store,
}) {
  const query = cp.queries.find((item) => item.text === row.query) || { text: row.query };
  const attemptToken = attempt.lease_token;
  let evidenceCapture = null;
  if (store.evidence?.capture) {
    evidenceCapture = await store.evidence.capture({
      observationId: row.id,
      token: attemptToken,
      index: 0,
      payload: rawTask,
      provider: "dataforseo",
      surface: row.engine,
      requestId: rawTask.id || attempt.provider_task_id || null,
    });
  }

  const opts = {
    measurementContext: { ...cp.measurement_context, surface: row.engine },
    prefetchedTask: rawTask,
    env,
  };
  let result;
  if (row.engine === "aio") {
    result = await probeAioDataforseo(
      query,
      cp.brand,
      aliases,
      domain,
      cp.competitors,
      undefined,
      opts,
    );
  } else {
    const probe = async (prompt, probeOpts) =>
      probeDataforseoScraper(row.engine, prompt, { ...probeOpts, ...opts });
    result = await probeTextEngine(
      { name: row.engine, probe },
      query,
      cp.brand,
      aliases,
      domain,
      cp.competitors,
      undefined,
      opts,
    );
  }

  // A malformed AIO result can fail before the adapter returns the provider's
  // posted cost. Preserve the known post charge in the result; SQL remains the
  // authority and will only apply a lower settled refund.
  if (result.cost == null && postedCost(row) != null) {
    result.cost = postedCost(row);
    result.cost_source = "gateway";
    result.cost_state = "measured";
  }

  const { resultMeta, envelope } = observationOptions({
    row,
    attempt,
    cp,
    captureEvidence: evidenceCapture,
  });
  const startedAt = resultMeta.capture_started_at;
  const completedAt = resultMeta.capture_completed_at;
  result = {
    ...result,
    ...resultMeta,
    attempt_id: attemptToken,
    provenance: createObservationEnvelope({
      ...result.provenance,
      ...result,
      ...envelope,
      method: result.provenance?.method || result.measurement_method || (row.engine === "aio" ? "google_serp" : "consumer_capture"),
      provider_request_id: result.provider_request_id || rawTask.id || null,
      started_at: startedAt,
      completed_at: completedAt,
    }),
  };
  return result;
}

async function collectPosted({ engine, postedRows, cp, store, now, env, tally }) {
  const aliases = getBrandAliases(cp.brand, cp.url);
  const domain = extractBrandDomain(cp.url);
  const deadline = Date.parse(cp.dispatch.deadline_at);
  for (let offset = 0; offset < postedRows.length; offset += TASK_GET_CONCURRENCY) {
    const batch = postedRows.slice(offset, offset + TASK_GET_CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      const attempt = attemptFor(row);
      const at = timeMs(now);
      if (Date.parse(row.next_attempt_at) > at) return;
      const taskId = attempt.provider_task_id || row.provider_task_id;
      if (!taskId || !attempt.lease_token) return;
      const age = at - Date.parse(attempt.posted_at || row.posted_at);
      if (!Number.isFinite(age) || age >= COLLECT_WINDOW_MIN * MINUTE_MS) {
        const result = taskFailure(engine, row.query, "Answer was paid for but not collected in time", undefined, postedCost(row), taskId);
        result.provider_failure = {
          kind: "provider_capacity",
          retryable: false,
          opens_circuit: false,
          message: "Queued answer was not collected before its window closed",
        };
        result.not_collected = true;
        await store.collect(row.id, attempt.lease_token, result, "failed", {
          kind: "not_collected",
          opens_circuit: false,
        }, null, null);
        tally.errorsRecovered = (tally.errorsRecovered || 0) + 1;
        return;
      }

      let outcome;
      try {
        outcome = await collectDataforseoTask(
          engine === "aio" ? "google_ai_overview" : engine,
          taskId,
          { env },
        );
      } catch {
        // A failed or uncertain free read does not change the posted state.
        return;
      }

      if (outcome.status === "pending") {
        const nextAt = nextPollAt(Date.parse(attempt.posted_at || row.posted_at), at);
        if (nextAt) {
          await store.reschedule(row.id, attempt.lease_token, nextAt);
        } else {
          const result = taskFailure(engine, row.query, "Answer was paid for but not collected in time", undefined, postedCost(row), taskId);
          result.provider_failure = {
            kind: "provider_capacity",
            retryable: false,
            opens_circuit: false,
            message: "Queued answer was not collected before its window closed",
          };
          result.not_collected = true;
          await store.collect(row.id, attempt.lease_token, result, "failed", {
            kind: "not_collected",
            opens_circuit: false,
          }, null, null);
          tally.errorsRecovered = (tally.errorsRecovered || 0) + 1;
        }
        return;
      }

      let result;
      if (outcome.status === "completed") {
        result = await postProcessedResult({
          row,
          attempt,
          rawTask: outcome.result,
          cp,
          env,
          aliases,
          domain,
          store,
        });
      } else {
        result = taskFailure(engine, row.query, outcome.message, outcome.statusCode, postedCost(row), taskId);
      }
      const decision = resultDecision(result, attempt.attempt_no, deadline, timeMs(now));
      result = {
        ...result,
        observation_id: row.id,
        attempt_count: attempt.attempt_no,
        attempt_disposition: decision.state,
        cost_uncertain: result.cost == null,
        ...(decision.failure
          ? { error: decision.failure.message, provider_failure: decision.failure }
          : {}),
      };
      const settledCost = outcome.costUsd ?? null;
      await store.collect(
        row.id,
        attempt.lease_token,
        result,
        decision.state,
        decision.failure,
        decision.next_at,
        settledCost,
      );
      if (result.error) tally.errorsRecovered = (tally.errorsRecovered || 0) + 1;
      else tally.probesSucceeded = (tally.probesSucceeded || 0) + 1;
    }));
  }
}

function isDue(row, at) {
  if (!row.next_attempt_at) return true;
  const dueAt = Date.parse(row.next_attempt_at);
  return !Number.isFinite(dueAt) || dueAt <= at;
}

async function finishUnbilledPost({ error, claims, store, cp, now, tally }) {
  const message = sanitizeProviderText(error?.message) || "DataForSEO refused the queued request.";
  const providerFailure = classifyProviderFailure({ provider: "dataforseo", error });
  for (const { row, claim } of claims) {
    const result = taskFailure(row.engine, row.query, message, error?.status, 0, null);
    result.provider_failure = providerFailure;
    result.cost = 0;
    result.cost_source = "gateway";
    result.cost_state = "measured";
    const decision = resultDecision(result, claim.attempt_no, Date.parse(cp.dispatch.deadline_at), timeMs(now));
    await store.finish(row.id, claim.lease_token, result, decision);
    if (decision.failure?.opens_circuit) {
      cp.blocked = { reason: decision.failure.kind, detail: decision.failure.message };
    }
    tally.errorsRecovered = (tally.errorsRecovered || 0) + 1;
  }
}

export async function runQueuedLane({ engine, rows, cp, store, budget, now, env, chunkStartMs, budgetMs, tally = {} }) {
  if (!rows.length) return { budgetHit: false, resumeAt: null };
  if (typeof store.listPosted !== "function" || typeof store.collect !== "function" || typeof store.post !== "function") {
    throw new AppError(500, "queued_dispatch_store_incomplete", "Queued dispatch storage is unavailable.");
  }
  const jobId = rows[0].job_id;
  const postedRows = (await store.listPosted(jobId)).filter((row) => row.engine === engine);
  await collectPosted({ engine, postedRows, cp, store, now, env, tally });

  const inLane = new Map(rows.map((row) => [row.id, row]));
  let budgetHit = false;
  while (true) {
    if (timeMs(now) - chunkStartMs >= budgetMs - 5_000) {
      budgetHit = true;
      break;
    }
    const current = await store.list(jobId);
    const pending = current
      .filter((row) => row.engine === engine && ["pending", "retry"].includes(row.state) && isDue(row, timeMs(now)))
      .filter((row) => inLane.has(row.id))
      .map((row) => ({ ...inLane.get(row.id), ...row }))
      .slice(0, MAX_TASKS_PER_POST);
    if (!pending.length) break;

    const claims = [];
    for (const row of pending) {
      const claim = await store.claim(row.id, { ...budget, leaseSeconds: QUEUED_LEASE_SECONDS });
      if (!claim?.granted) {
        if (["provider_circuit_open", "spend_reservation_refused", "dispatch_paused"].includes(claim?.reason)) {
          cp.blocked = { reason: claim.reason, detail: "Dispatch refused before provider request" };
          budgetHit = true;
          break;
        }
        continue;
      }
      claims.push({ row, claim });
    }
    if (!claims.length) break;

    try {
      const market = dataforseoMarket(cp.measurement_context);
      const posted = await postDataforseoBatch(
        engine === "aio" ? "google_ai_overview" : engine,
        claims.map(({ row }) => ({ observationId: row.id, query: row.query })),
        market,
        { env },
      );
      const byId = new Map(claims.map((item) => [item.row.id, item]));
      for (const entry of posted.posted) {
        const item = byId.get(entry.observationId);
        if (!item) continue;
        const postedAt = timeMs(now);
        await store.post(
          item.row.id,
          item.claim.lease_token,
          entry.taskId,
          entry.costUsd,
          iso(postedAt + 120 * SECOND_MS),
          iso(postedAt + COLLECT_WINDOW_MIN * MINUTE_MS),
        );
      }
      for (const entry of posted.rejected) {
        const item = byId.get(entry.observationId);
        if (!item) continue;
        const result = taskFailure(engine, item.row.query, entry.message, entry.statusCode, entry.costUsd, null);
        const decision = resultDecision(result, item.claim.attempt_no, Date.parse(cp.dispatch.deadline_at), timeMs(now));
        await store.finish(item.row.id, item.claim.lease_token, result, decision);
        if (decision.failure?.opens_circuit) {
          cp.blocked = { reason: decision.failure.kind, detail: decision.failure.message };
        }
        tally.errorsRecovered = (tally.errorsRecovered || 0) + 1;
      }
    } catch (error) {
      if (error?.name === "UnbilledCallError") {
        await finishUnbilledPost({ error, claims, store, cp, now, tally });
      } else {
        // A task_post may have been charged even when its response was lost or
        // malformed. Leave every lease unresolved for the SQL ambiguity fence.
        cp.blocked = {
          reason: "dispatch_unknown",
          detail: "Provider dispatch may have been billed; operator reconciliation required",
        };
        budgetHit = true;
        break;
      }
    }
    if (cp.blocked) {
      budgetHit = true;
      break;
    }
  }

  const remaining = (await store.list(jobId)).some((row) =>
    row.engine === engine && inLane.has(row.id) && ["pending", "retry"].includes(row.state) && isDue(row, timeMs(now))
  );
  return { budgetHit: budgetHit || remaining, resumeAt: null };
}
