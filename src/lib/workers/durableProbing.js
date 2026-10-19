import {
  dispatchIdentity,
  hashIdentity,
  DISPATCH_VERSION,
  PROBE_LEASE_SECONDS,
  PROBE_REQUEST_MS,
  resultDecision,
} from "../db/probeDispatch.js";
import { validateEngineConfig } from "../engines/providerReadiness.js";
import {
  classifyProviderFailure,
  sanitizeProviderText,
} from "../engines/providerFailure.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { extractBrandDomain } from "../scoring/citations.js";

const terminal = new Set([
  "answered",
  "valid_no_aio",
  "failed",
  "ambiguous",
  "blocked",
]);
export function dispatchBudget(env = process.env) {
  const positive = (key, fallback = null) => {
    if (!env[key]?.trim()) return fallback;
    const value = Number(env[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
    return value;
  };
  const reserve = positive("SCAN_PROBE_RESERVATION_USD", 1);
  if (reserve <= 0)
    throw new Error("SCAN_PROBE_RESERVATION_USD must be positive");
  return {
    reserve,
    scanCap: positive("SCAN_MAX_COST_PER_SCAN"),
    dayCap: positive("SCAN_MAX_COST_PER_DAY"),
  };
}

export function freezeDispatch({
  engines,
  stats = {},
  env = process.env,
  now = Date.now,
}) {
  return {
    version: DISPATCH_VERSION,
    deadline_at: new Date(now() + 24 * 60 * 60_000).toISOString(),
    identities: Object.fromEntries(
      engines.map((name) => [name, dispatchIdentity(name, env)]),
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
  cp.dispatch ||= {
    version: DISPATCH_VERSION,
    deadline_at: new Date(now() + 24 * 60 * 60_000).toISOString(),
    identities: Object.fromEntries(
      (cp.engines || engines.map((e) => e.name)).map((name) => [
        name,
        dispatchIdentity(name, env),
      ]),
    ),
    sourcing_cost: Math.max(
      0,
      Number(cp.stats?.cost || 0) -
        stored.reduce((n, r) => n + (Number(r.raw?.cost) || 0), 0),
    ),
    sourcing_unknown: Math.max(
      0,
      Number(cp.stats?.cost_unmeasured_calls || 0) -
        stored.filter((r) => r.raw?.cost == null).length,
    ),
  };
  const queries = cp.queries;
  if (
    !queries.length ||
    new Set(queries.map((q) => q.text)).size !== queries.length
  )
    throw new Error("Invalid or duplicate planned query identity");
  const historical = new Map(
    stored.map((r) => [`${r.engine}|${r.query}`, r.raw]),
  );
  const names = cp.engines || engines.map((e) => e.name);
  const context = {
    version: DISPATCH_VERSION,
    panel: hashIdentity(queries),
    geo: cp.geo || null,
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
  const budget = dispatchBudget(env);
  for (const row of rows)
    if (row.historical) row.historical.reserve = budget.reserve;
  await store.seed(rows);
  const aliases = getBrandAliases(cp.brand, cp.url);
  const domain = extractBrandDomain(cp.url);
  let stats = { ...cp.stats };
  // Serial dispatch lets a permanent failure stop the very next dependent
  // request. Workers still run independently; SQL owns all authorization.
  for (const row of rows) {
    if (now() - chunkStartMs + PROBE_REQUEST_MS + 5_000 > budgetMs) break;
    const engine = engines.find((e) => e.name === row.engine);
    if (
      !engine ||
      !validateEngineConfig(row.engine, env).ok ||
      dispatchIdentity(row.engine, env).config_version !== row.config_version
    ) {
      cp.blocked = {
        reason: "engine_not_registered",
        detail: `Frozen configuration unavailable: ${row.engine}`,
      };
      await store.block(row.id, "configuration_changed");
      continue;
    }
    const claim = await store.claim(row.id, budget);
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
      continue;
    }
    tally.probesAttempted = (tally.probesAttempted || 0) + 1;
    let result;
    try {
      result = await engine.probe(
        queries.find((q) => q.text === row.query),
        cp.brand,
        aliases,
        domain,
        cp.competitors,
        stats,
        {
          geo: cp.geo,
          durableDispatch: true,
          deadlineAt: now() + PROBE_REQUEST_MS,
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
  }
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
  const dueTimes = remaining.map((o) =>
    o.state === "leased"
      ? Date.parse(o.lease_until)
      : Date.parse(o.next_attempt_at),
  );
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
