import {
  createProbeDispatchStore,
  dispatchIdentity,
  hashIdentity,
  resultDecision,
  PROBE_REQUEST_MS,
} from "../db/probeDispatch.js";
import { resolveEnabledEngines } from "../scoring/enginePipeline.js";
import { dispatchBudget } from "../workers/durableProbing.js";
import { createObservationEnvelope } from "../provenance.js";
import { resolveSerpGeo,resolveMeasurementContext } from "../engines/serpGeo.js";
import {
  validateEngineConfig,
  planEngineCanary,
} from "../engines/providerReadiness.js";
import { classifyProviderFailure } from "../engines/providerFailure.js";
import { routeOrder } from "../engines/engineRoutes.ts";

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
  route,
  routes,
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
    const effectiveRoute = route ?? routes?.[name] ?? routeOrder(name, env)[0];
    const routeOpts = effectiveRoute ? { route: effectiveRoute } : {};
    const config = validateEngineConfig(name, env, routeOpts);
    const engine = registry.find((e) => e.name === name);
    if (!config.ok || !engine) {
      outcomes.push({
        engine: name,
        state: "blocked",
        reason: config.reason || "engine_not_registered",
      });
      continue;
    }
    const identity = dispatchIdentity(name, env, routeOpts);
    const requestUnits =
      effectiveRoute === "dataforseo"
        ? 1
        : name === "perplexity" &&
          planEngineCanary(name, env, routeOpts).provider === "perplexity"
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
    const captures=[],startedAt=new Date(now()).toISOString();
    const context=resolveMeasurementContext({country:geo});
    const captureEvidence=store.evidence ? async input=>{const capture=await store.evidence.capture({observationId:id,token:claim.lease_token,index:captures.length,...input});captures.push(capture);} : null;
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
        { geo,measurementContext:context,captureEvidence,durableDispatch: true, deadlineAt: now() + PROBE_REQUEST_MS, ...(effectiveRoute ? { route: effectiveRoute } : {}) },
      );
    } catch (error) {
      result = {
        engine: name,
        error: "Canary provider call failed",
        cost: null,
        provider_failure: classifyProviderFailure({ error }),
      };
    }
    result={...result,observation_id:id,attempt_id:claim.lease_token,evidence_captures:captures,
      evidence_state:store.evidence?(captures.length && captures.every(c=>c.state==='stored')?'stored':'incomplete'):'unverified'};
    result.provenance=createObservationEnvelope({...result.provenance,...result,surface:result.provenance?.surface || name,
      observation_id:id,attempt_id:claim.lease_token,attempt_number:claim.attempt_no,requested_location:geo,
      method:result.provenance?.method || result.measurement_method || "model_api",gateway:result.provenance?.gateway || (name==="aio"?"brightdata":"unknown"),
      language:context.language,device:context.device,session_policy:context.session_policy,started_at:startedAt,completed_at:new Date(now()).toISOString(),evidence_identities:captures.map(c=>c.sha256).filter(Boolean)});
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
