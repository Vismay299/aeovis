import {createObservationEnvelope} from "../../shared/provenance.js";
import {resolveMeasurementContext} from '../../shared/engines/serpGeo.js';
import {
  dispatchIdentity,
  hashIdentity,
  DISPATCH_VERSION,
  PROBE_LEASE_SECONDS,
  PROBE_REQUEST_MS,
  resultDecision,
  withLeaseRenewal,
} from "../db/probeDispatch.js";
import { validateEngineConfig } from "../../shared/engines/providerReadiness.js";
import {
  classifyProviderFailure,
  sanitizeProviderText,
} from "../../shared/engines/providerFailure.js";
import { getBrandAliases } from "../../shared/scoring/aliases.js";
import { extractBrandDomain } from "../../shared/scoring/citations.js";
import {
  isRouteScanCapable,
  resolveFrozenRoutes,
  requestBudgetMs,
  leaseSecondsFor,
  laneConcurrency,
  DATAFORSEO_SCAN_MODES,
} from "../../shared/engines/engineRoutes.ts";
import { runQueuedLane } from "./queuedCollection.js";

const terminal = new Set([
  "answered",
  "valid_no_aio",
  "failed",
  "ambiguous",
  "blocked",
]);
function minNullable(a, b) {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

export function dispatchBudget(env = process.env, opts = {}) {
  const positive = (key, fallback = null) => {
    if (!env[key]?.trim()) return fallback;
    const value = Number(env[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
    return value;
  };
  const reserve = positive("SCAN_PROBE_RESERVATION_USD", 1);
  if (reserve <= 0)
    throw new Error("SCAN_PROBE_RESERVATION_USD must be positive");
  const envScanCap = positive("SCAN_MAX_COST_PER_SCAN");
  const approvedMaxUsd = opts?.approvedMaxUsd == null ? null : Number(opts.approvedMaxUsd);
  if (approvedMaxUsd !== null && (!Number.isFinite(approvedMaxUsd) || approvedMaxUsd <= 0)) {
    throw new Error("approvedMaxUsd must be positive");
  }
  return {
    reserve,
    scanCap: minNullable(envScanCap, approvedMaxUsd),
    dayCap: positive("SCAN_MAX_COST_PER_DAY"),
  };
}

export function freezeDispatch({
  engines,
  stats = {},
  env = process.env,
  now = Date.now,
  routes,
}) {
  return {
    version: DISPATCH_VERSION,
    deadline_at: new Date(now() + 24 * 60 * 60_000).toISOString(),
    ...(routes ? { routes } : {}),
    identities: Object.fromEntries(
      engines.map((name) => [
        name,
        dispatchIdentity(name, env, routes?.[name] ? { route: routes[name].route, model: routes[name].model } : undefined),
      ]),
    ),
    sourcing_cost: Number(stats.cost || 0),
    sourcing_unknown: Number(stats.cost_unmeasured_calls || 0),
  };
}

// Full matrix frozen before the first claim. Existing raw rows are adopted as
// historical attempts, never silently reclassified as a successful collection.
export async function runDurableProbing({
  jobId,
  checkpoint,
  engines,
  store,
  getResults,
  updateJob,
  now = Date.now,
  chunkStartMs,
  budgetMs,
  env = process.env,
  tally = {},
}) {
  const cp = { ...checkpoint };
  const stored = await getResults(jobId);
  const names = cp.engines || engines.map((e) => e.name);

  if (!cp.dispatch) {
    let openCircuitKeys = new Set();
    if (store && typeof store.circuits === "function") {
      try {
        const circuits = await store.circuits();
        openCircuitKeys = new Set(
          circuits
            .filter((c) => c.open_until && Date.parse(c.open_until) > now())
            .map((c) => c.circuit_key),
        );
      } catch {
        // ignore circuit read failures
      }
    }
    const routes = await resolveFrozenRoutes(names, { env, openCircuitKeys });
    cp.dispatch = freezeDispatch({
      engines: names,
      stats: cp.stats,
      env,
      now,
      routes,
    });
    cp.dispatch.sourcing_cost = Math.max(
      0,
      Number(cp.stats?.cost || 0) -
        stored.reduce((n, r) => n + (Number(r.raw?.cost) || 0), 0),
    );
    cp.dispatch.sourcing_unknown = Math.max(
      0,
      Number(cp.stats?.cost_unmeasured_calls || 0) -
        stored.filter((r) => r.raw?.cost == null).length,
    );
  }

  cp.measurement_context ||= resolveMeasurementContext({country:typeof cp.geo === "string" ? cp.geo : cp.geo?.country});
  const queries = cp.queries;
  if (
    !queries.length ||
    new Set(queries.map((q) => q.text)).size !== queries.length
  )
    throw new Error("Invalid or duplicate planned query identity");
  const historical = new Map(
    stored.map((r) => [`${r.engine}|${r.query}`, r.raw]),
  );
  const context = {
    version: cp.dispatch.version,
    panel: hashIdentity(queries),
    geo: cp.geo || null,
    ...(cp.dispatch.version !== "durable-probes-v1" ? {measurement_context:cp.measurement_context} : {}),
    model_policy_version: cp.model_policy_version || null,
    sourcing_cost: cp.dispatch.sourcing_cost,
  };
  const rows = names.flatMap((engine) =>
    queries.map((query) => {
      const prior = historical.get(`${engine}|${query.text}`);
      const identity = cp.dispatch.identities[engine];
      return {
        id: hashIdentity({ jobId, engine, query: query.text }),
        job_id: jobId,
        purpose: "scan",
        engine,
        query: query.text,
        context,
        ...identity,
        deadline_at: cp.dispatch.deadline_at,
        historical: prior
          ? {
              result: prior,
              ...resultDecision(
                prior,
                1,
                Date.parse(cp.dispatch.deadline_at),
                now(),
              ),
            }
          : null,
      };
    }),
  );
  await updateJob(jobId, { checkpoint: cp });
  const budget = dispatchBudget(env, { approvedMaxUsd: cp.approved_max_usd ?? null });
  for (const row of rows)
    if (row.historical) row.historical.reserve = budget.reserve;
  await store.seed(rows);
  const aliases = getBrandAliases(cp.brand, cp.url);
  const domain = extractBrandDomain(cp.url);
  let stats = { ...cp.stats };
  // One serial lane per engine: a permanent failure still stops the next request
  // to that provider, but one slow or blocked engine no longer starves the
  // others, and a chunk that stops early leaves whole questions rather than one
  // engine's prefix. SQL owns all authorization; claims serialize on its lock.
  async function dispatchRow(row) {
    const engine = engines.find((e) => e.name === row.engine);
    const routeInfo = cp.dispatch?.routes?.[row.engine];
    const route = routeInfo?.route;
    const model = routeInfo?.model;
    const routeOpts = routeInfo ? { route, model } : undefined;

    if (route && !isRouteScanCapable(row.engine, route)) {
      cp.blocked = {
        reason: "route_not_scan_capable",
        detail: `Route ${route} is not scan-capable for ${row.engine}`,
      };
      await store.block(row.id, "route_not_scan_capable");
      return;
    }

    if (
      !engine ||
      !validateEngineConfig(row.engine, env, routeOpts).ok ||
      dispatchIdentity(row.engine, env, routeOpts).config_version !== row.config_version
    ) {
      cp.blocked = {
        reason: "engine_not_registered",
        detail: `Frozen configuration unavailable: ${row.engine}`,
      };
      await store.block(row.id, "configuration_changed");
      return;
    }

    const leaseSeconds = leaseSecondsFor(row.engine, route);
    const claim = await store.claim(row.id, route ? { ...budget, leaseSeconds } : budget);
    if (!claim?.granted) {
      if (
        [
          "provider_circuit_open",
          "spend_reservation_refused",
          "dispatch_paused",
        ].includes(claim?.reason)
      )
        cp.blocked = {
          reason: claim.reason,
          detail: "Dispatch refused before provider request",
        };
      return;
    }
    tally.probesAttempted = (tally.probesAttempted || 0) + 1;
    let result;
    const captures = [];
    const evidence = store.evidence;
    const captureEvidence = evidence
      ? async (input) => {
          captures.push(
            await evidence.capture({
              observationId: row.id,
              token: claim.lease_token,
              index: captures.length,
              ...input,
            }),
          );
        }
      : null;
    const startedAt = new Date(now()).toISOString();
    const probeTimeoutMs = requestBudgetMs(row.engine, route);
    try {
      result = await withLeaseRenewal(
        store,
        row.id,
        claim.lease_token,
        leaseSeconds,
        async () => {
          return await engine.probe(
            queries.find((q) => q.text === row.query),
            cp.brand,
            aliases,
            domain,
            cp.competitors,
            stats,
            {
              geo: cp.geo,
              measurementContext: { ...cp.measurement_context, surface: row.engine },
              captureEvidence,
              durableDispatch: true,
              deadlineAt: now() + probeTimeoutMs,
              ...(route ? { route, model } : {}),
            },
          );
        },
      );
    } catch (error) {
      result = {
        engine: row.engine,
        prompt: row.query,
        error: sanitizeProviderText(error.message),
        cost: null,
        answer_present: false,
        provider_failure: classifyProviderFailure({ error }),
      };
    }
    result = {
      ...result,
      measurement_context: { ...cp.measurement_context, surface: row.engine },
      observed_location: null,
      location_verification: "unverified",
      capture_started_at: startedAt,
      capture_completed_at: new Date(now()).toISOString(),
      evidence_state: evidence
        ? captures.length && captures.every((c) => c.state === "stored")
          ? "stored"
          : "incomplete"
        : "unverified",
      evidence_captures: captures,
    };
    result.attempt_id = claim.lease_token;
    result.provenance = createObservationEnvelope({
      ...result.provenance,
      ...result,
      observation_id: row.id,
      attempt_id: claim.lease_token,
      attempt_number: claim.attempt_no,
      surface: result.provenance?.surface || row.engine,
      method: result.provenance?.method || result.measurement_method || "model_api",
      gateway:
        result.provenance?.gateway ||
        result.gateway ||
        (row.engine === "aio" ? "brightdata" : "unknown"),
      requested_location: cp.measurement_context.country,
      language: cp.measurement_context.language,
      device: cp.measurement_context.device,
      session_policy: cp.measurement_context.session_policy,
      started_at: startedAt,
      completed_at: result.capture_completed_at,
      evidence_identities: captures.map((c) => c.sha256).filter(Boolean),
      evidence_state: result.evidence_state,
    });
    if (evidence && ["unknown_schema", "malformed"].includes(result.serp_state)) {
      await evidence.incident({
        observationId: row.id,
        engine: row.engine,
        parserVersion: result.parser_version,
        shape: JSON.stringify(result.validation_errors || []),
      });
    }
    const decision = resultDecision(
      result,
      claim.attempt_no,
      Date.parse(cp.dispatch.deadline_at),
      now(),
    );
    result = {
      ...result,
      observation_id: row.id,
      attempt_count: claim.attempt_no,
      attempt_disposition: decision.state,
      cost_uncertain: result.cost == null,
      ...(decision.failure
        ? {
            error: decision.failure.message,
            provider_failure: decision.failure,
          }
        : {}),
    };
    const saved = await store.finish(
      row.id,
      claim.lease_token,
      result,
      decision,
    );
    if (!saved?.accepted)
      throw new Error(
        "Provider result fenced by expired lease; reconciliation required",
      );
    if (result.error) tally.errorsRecovered = (tally.errorsRecovered || 0) + 1;
    else tally.probesSucceeded = (tally.probesSucceeded || 0) + 1;
    // Reconstruct spend from the durable ledger below, including recovered work.
    await updateJob(jobId, { checkpoint: { ...cp, stats }, attempts: 0 });
    return result;
  }
  const lanes = new Map();
  for (const row of rows) {
    if (!lanes.has(row.engine)) lanes.set(row.engine, []);
    lanes.get(row.engine).push(row);
  }
  const settled = await Promise.allSettled(
    [...lanes.entries()].map(async ([engineName, lane]) => {
      const routeInfo = cp.dispatch?.routes?.[engineName];
      const route = routeInfo?.route;
      const concurrency = laneConcurrency(engineName, route, env);
      let laneStopped = false;
      let index = 0;

      async function worker() {
        while (index < lane.length && !laneStopped) {
          const row = lane[index++];
          if (
            route === "dataforseo" &&
            DATAFORSEO_SCAN_MODES[engineName]?.endsWith("_queued")
          ) {
            const engine = engines.find((item) => item.name === engineName);
            const routeOpts = routeInfo ? { route, model: routeInfo.model } : undefined;
            const blockedReason = !isRouteScanCapable(engineName, route)
              ? "route_not_scan_capable"
              : !engine || !validateEngineConfig(engineName, env, routeOpts).ok ||
                  dispatchIdentity(engineName, env, routeOpts).config_version !== lane[0]?.config_version
                ? "configuration_changed"
                : null;
            if (blockedReason) {
              cp.blocked = {
                reason: blockedReason === "configuration_changed" ? "engine_not_registered" : blockedReason,
                detail: blockedReason === "configuration_changed"
                  ? `Frozen configuration unavailable: ${engineName}`
                  : `Route ${route} is not scan-capable for ${engineName}`,
              };
              await Promise.all(lane.map((item) => store.block(item.id, blockedReason)));
              laneStopped = true;
              continue;
            }
            await runQueuedLane({
              engine: engineName,
              rows: lane,
              cp,
              store,
              budget,
              now,
              env,
              chunkStartMs,
              budgetMs,
              tally,
            });
            laneStopped = true;
            continue;
          }
          const reqBudget = requestBudgetMs(row.engine, route);
          if (now() - chunkStartMs + reqBudget + 5_000 > budgetMs) {
            break;
          }
          const res = await dispatchRow(row);
          if (res?.provider_failure?.opens_circuit) {
            laneStopped = true;
          }
        }
      }

      const workers = Array.from({ length: Math.min(concurrency, lane.length) }, () => worker());
      await Promise.all(workers);
    }),
  );
  const laneFailure = settled.find((s) => s.status === "rejected");
  if (laneFailure) throw laneFailure.reason;
  const observations = await store.list(jobId);
  const remaining = observations.filter((o) => !terminal.has(o.state));
  const measured = observations.reduce(
    (sum, o) => sum + (Number(o.total_cost) || 0),
    0,
  );
  const unknown = observations.reduce(
    (sum, o) => sum + (Number(o.unknown_cost_calls) || 0),
    0,
  );
  cp.stats = {
    ...stats,
    cost: cp.dispatch.sourcing_cost + measured,
    cost_unmeasured_calls: cp.dispatch.sourcing_unknown + unknown,
  };
  cp.dispatch_summary = {
    observations: observations.length,
    attempts: observations.reduce((n, o) => n + o.attempt_count, 0),
    ambiguous: observations.filter((o) => o.state === "ambiguous").length,
    retrying: remaining.length,
    unknown_cost_calls: unknown,
  };
  if (cp.dispatch_summary.ambiguous)
    cp.blocked = {
      reason: "dispatch_unknown",
      detail:
        "Provider dispatch may have been billed; operator reconciliation required",
    };
  const progressPct = Math.min(
    85,
    25 +
      Math.round(
        ((observations.length - remaining.length) / Math.max(1, rows.length)) *
          60,
      ),
  );
  await updateJob(jobId, { checkpoint: cp, progress_pct: progressPct });
  const dueTimes = remaining
    .map((o) =>
      o.state === "leased"
        ? Date.parse(o.lease_until)
        : Date.parse(o.next_attempt_at),
    )
    .filter(Number.isFinite);
  const resumeAt = dueTimes.length
    ? new Date(Math.min(...dueTimes)).toISOString()
    : null;
  return {
    checkpoint: cp,
    progressPct,
    budgetHit: remaining.length > 0,
    resumeAt,
  };
}
