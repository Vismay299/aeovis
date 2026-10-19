import crypto from "node:crypto";
import { supabase } from "../db.js";
import {
  circuitIdentity,
  configVersion,
  buildProviderReadiness,
} from "../engines/providerReadiness.js";
import {
  classifyProviderFailure,
  classifyProviderFailureEnvelope,
} from "../engines/providerFailure.js";
import { planRetry } from "../attemptPolicy.js";

export const DISPATCH_VERSION = "durable-probes-v1";
export const PROBE_LEASE_SECONDS = 120;
export const PROBE_REQUEST_MS = 70_000;
// jsonb may reorder object keys between chunks. Canonicalize recursively so a
// resumed checkpoint retains exactly the same observation/config identity.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const hashIdentity = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export function dispatchIdentity(engine, env = process.env) {
  return {
    config_version: configVersion(engine, env),
    circuit_key: hashIdentity(circuitIdentity(engine, env)),
  };
}

export function resultDecision(
  result,
  attempt,
  deadlineMs,
  nowMs = Date.now(),
) {
  if (
    !result?.error &&
    (result?.answer_present ||
      (result?.engine === "aio" &&
        result?.serp_state === "valid_serp" &&
        result?.aio_present === false))
  ) {
    return {
      state: result.answer_present ? "answered" : "valid_no_aio",
      failure: result?.provider_failure || null,
      next_at: null,
    };
  }
  const failure =
    result?.provider_failure ||
    (result?.error
      ? classifyProviderFailureEnvelope(null, result)
      : classifyProviderFailure({
          parseError: new Error("Unreadable measurement"),
        }));
  const retry = planRetry({
    failure,
    attemptNumber: attempt,
    nowMs,
    deadlineMs,
  });
  return {
    state: retry.retry ? "retry" : "failed",
    failure,
    next_at: retry.next_attempt_at,
  };
}

export function createProbeDispatchStore(client = supabase) {
  if (!client)
    throw new Error("Durable provider dispatch requires the service database");
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error)
      throw new Error(
        `Durable provider dispatch ${name} failed: ${error.message}`,
      );
    return data;
  }
  return {
    block: (id, reason) =>
      rpc("block_probe_dispatch", { p_id: id, p_reason: reason }),
    seed: (rows) => rpc("seed_probe_observations", { p_rows: rows }),
    claim: (id, { reserve, scanCap = null, dayCap = null }) =>
      rpc("claim_probe_dispatch", {
        p_id: id,
        p_reserve: reserve,
        p_scan_cap: scanCap,
        p_day_cap: dayCap,
        p_lease_seconds: PROBE_LEASE_SECONDS,
      }),
    finish: (id, token, result, decision) =>
      rpc("finish_probe_dispatch", {
        p_id: id,
        p_token: token,
        p_result: result,
        p_state: decision.state,
        p_failure: decision.failure,
        p_next_at: decision.next_at,
      }),
    async list(jobId) {
      const { data, error } = await client
        .from("probe_observations")
        .select("*")
        .eq("job_id", jobId)
        .order("created_at");
      if (error) throw error;
      return data || [];
    },
    async circuits() {
      const { data, error } = await client
        .from("provider_dispatch_circuits")
        .select("circuit_key,open_until,failure")
        .not("open_until", "is", null);
      if (error) throw error;
      return data || [];
    },
    async canaries() {
      const { data, error } = await client
        .from("probe_observations")
        .select(
          "engine,config_version,state,observed_at,result,reason,created_at,context,probe_attempts(started_at,finished_at,attempt_no)",
        )
        .eq("purpose", "canary")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const byEngine = {};
      for (const row of data || []) {
        if (byEngine[row.engine]) continue;
        const lastAttempt = [...(row.probe_attempts || [])].sort(
          (a, b) => b.attempt_no - a.attempt_no,
        )[0];
        const failure = row.result?.provider_failure;
        byEngine[row.engine] = {
          config_version: row.config_version,
          observed_at: row.observed_at,
          started_at: lastAttempt?.started_at || null,
          ended_at: lastAttempt?.finished_at || null,
          requested_location: row.context?.geo || null,
          location_status: "unverified",
          outcome: ["answered", "valid_no_aio"].includes(row.state)
            ? "valid"
            : row.state,
          kind: row.reason,
          failure: failure
            ? {
                kind: failure.kind,
                message: failure.message,
                action: failure.action,
                retry_after_ms: failure.retry_after_ms,
              }
            : null,
          provider_request_id: row.result?.provider_request_id || null,
          parser_version: row.result?.parser_version || null,
          evidence_id: row.result?.evidence_id || null,
        };
      }
      return byEngine;
    },
  };
}

export async function readProviderReadiness({
  store = createProbeDispatchStore(),
  env = process.env,
  now = new Date().toISOString(),
} = {}) {
  const [canaries, circuits] = await Promise.all([
    store.canaries(),
    store.circuits ? store.circuits() : [],
  ]);
  const report = buildProviderReadiness({ env, now, canaries });
  // An older valid canary cannot conceal a newer permanent account fault.
  // The circuit remains open to questions until a recovery canary closes it.
  for (const [engine, reading] of Object.entries(report.engines)) {
    const identity = dispatchIdentity(engine, env);
    const open = circuits.find(
      (c) => c.circuit_key === identity.circuit_key && c.open_until,
    );
    if (!open) continue;
    report.summary[reading.readiness] = report.summary[
      reading.readiness
    ].filter((name) => name !== engine);
    report.summary.blocked.push(engine);
    reading.readiness = "blocked";
    reading.current = false;
    reading.reason = "provider_circuit_open";
    reading.detail =
      "A measured provider account failure opened its shared circuit";
    reading.operator_action =
      open.failure?.action ||
      "Investigate provider failure, then run a recovery canary";
    reading.circuit_recovery_at = open.open_until;
    report.degraded_reason = `${reading.label} is blocked by a measured provider failure`;
  }
  return report;
}
