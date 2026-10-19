#!/usr/bin/env node
// Deliberate operator dispatch. /api/health only reads these durable results.
import { pathToFileURL } from "node:url";
import {
  createProbeDispatchStore,
  dispatchIdentity,
  hashIdentity,
  resultDecision,
  PROBE_REQUEST_MS,
} from "../../src/lib/db/probeDispatch.js";
import { resolveEnabledEngines } from "../../src/lib/scoring/enginePipeline.js";
import { dispatchBudget } from "../../src/lib/workers/durableProbing.js";
import { resolveSerpGeo } from "../../src/lib/engines/serpGeo.js";
import {
  validateEngineConfig,
  planEngineCanary,
} from "../../src/lib/engines/providerReadiness.js";
import { classifyProviderFailure } from "../../src/lib/engines/providerFailure.js";

export async function dispatchCanaries({
  engines,
  slot,
  maxRequests,
  maxSpendUsd,
  reserveUsd,
  store = createProbeDispatchStore(),
  registry = resolveEnabledEngines({ allowFallback: false }),
  env = process.env,
  now = Date.now,
}) {
  if (
    !slot ||
    !Number.isInteger(maxRequests) ||
    maxRequests < 1 ||
    !Number.isFinite(maxSpendUsd) ||
    maxSpendUsd <= 0 ||
    !Number.isFinite(reserveUsd) ||
    reserveUsd <= 0 ||
    !engines?.length ||
    new Set(engines).size !== engines.length
  ) {
    throw new Error(
      "Canary requires a unique shared --slot, engines, positive request/spend ceilings and reservation",
    );
  }
  const geo = resolveSerpGeo();
  const scope = `provider-canary:${slot}`;
  const outcomes = [];
  for (const name of engines) {
    const config = validateEngineConfig(name, env);
    const engine = registry.find((e) => e.name === name);
    if (!config.ok || !engine) {
      outcomes.push({
        engine: name,
        state: "blocked",
        reason: config.reason || "engine_not_registered",
      });
      continue;
    }
    const identity = dispatchIdentity(name, env);
    const requestUnits =
      name === "perplexity" &&
      planEngineCanary(name, env).provider === "perplexity"
        ? 2
        : name === "aio"
          ? 2
          : 1;
    const id = hashIdentity({ scope, name, geo, ...identity });
    await store.seed([
      {
        id,
        job_id: null,
        purpose: "canary",
        engine: name,
        query:
          "What factors should a small business consider when choosing accounting software?",
        ...identity,
        context: {
          budget_scope: scope,
          max_requests: maxRequests,
          request_units: requestUnits,
          geo,
        },
        deadline_at: new Date(now() + 5 * 60_000).toISOString(),
      },
    ]);
    const budget = dispatchBudget(env);
    const claim = await store.claim(id, {
      reserve: reserveUsd,
      scanCap: maxSpendUsd,
      dayCap: budget.dayCap,
    });
    if (!claim.granted) {
      outcomes.push({ engine: name, state: "refused", reason: claim.reason });
      continue;
    }
    let result;
    try {
      result = await engine.probe(
        {
          text: "What factors should a small business consider when choosing accounting software?",
        },
        "Acme",
        ["Acme"],
        "acme.example",
        [],
        {},
        { geo, durableDispatch: true, deadlineAt: now() + PROBE_REQUEST_MS },
      );
    } catch (error) {
      result = {
        engine: name,
        error: "Canary provider call failed",
        cost: null,
        provider_failure: classifyProviderFailure({ error }),
      };
    }
    // Canary retries are separate operator invocations of the same slot and
    // use the same durable due time, maximum attempts and shared reservations.
    const decision = resultDecision(
      result,
      claim.attempt_no,
      now() + 5 * 60_000,
      now(),
    );
    const saved = await store.finish(
      id,
      claim.lease_token,
      { ...result, provider_failure: decision.failure },
      decision,
    );
    outcomes.push({
      engine: name,
      state: saved.accepted ? decision.state : "ambiguous",
      reason: decision.failure?.kind || null,
    });
  }
  return outcomes;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, index, list) => {
      if (value.startsWith("--")) pairs.push([value.slice(2), list[index + 1]]);
      return pairs;
    }, []),
  );
  try {
    const result = await dispatchCanaries({
      engines: args.engines?.split(","),
      slot: args.slot,
      maxRequests: Number(args["max-requests"]),
      maxSpendUsd: Number(args["max-spend-usd"]),
      reserveUsd: Number(args["reserve-usd"]),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.some((r) => !["answered", "valid_no_aio"].includes(r.state)))
      process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
