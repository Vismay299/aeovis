import { resolveLatestLlmModelName } from "../providers/dataforseo/llm-models.ts";
import { circuitIdentity } from "./providerReadiness.js";
import { hashIdentity } from "../db/probeDispatch.js";
import { isFeatureEnabled } from "../features/flags.ts";
import { QUEUED_COLLECTION_READY } from "../workers/queuedCollection.js";
import {
  DATAFORSEO_APPROVED_ENGINES,
  DEFAULT_ROUTE_ORDER,
  isRouteConfigured,
  parseAnswerEngineRoutes,
  routeOrder,
} from "./openRouterProbe.js";

export type EngineName = "aio" | "chatgpt" | "gemini" | "perplexity";
export type RouteId = "dataforseo" | "brightdata" | "openrouter" | "vendor_api";
export type DataforseoRouteMode =
  | "scraper_live"
  | "scraper_queued"
  | "serp_live"
  | "serp_queued"
  | "model_live";

export const DATAFORSEO_SCAN_MODES: Record<EngineName, DataforseoRouteMode> = {
  aio: "serp_queued",
  chatgpt: "scraper_queued",
  gemini: "scraper_queued",
  perplexity: "model_live",
};
export { DATAFORSEO_APPROVED_ENGINES, DEFAULT_ROUTE_ORDER, isRouteConfigured, parseAnswerEngineRoutes, routeOrder };
export function isRouteScanCapable(engine: EngineName, route: RouteId): boolean {
  if (route !== "dataforseo") return true;
  const mode = DATAFORSEO_SCAN_MODES[engine];
  return mode === "model_live" || (QUEUED_COLLECTION_READY && mode.endsWith("_queued"));
}

export async function resolveFrozenRoutes(
  engines: EngineName[],
  deps: {
    env?: Record<string, string | undefined>;
    isFeatureEnabled?: (name: string) => Promise<boolean>;
    openCircuitKeys?: Set<string>;
    resolveModel?: (slug: string) => Promise<string>;
  } = {},
): Promise<Record<EngineName, { route: RouteId; model: string | null; fallbackFrom: RouteId | null }>> {
  const env = deps.env ?? process.env;
  const checkFeature = deps.isFeatureEnabled ?? isFeatureEnabled;
  const openKeys = deps.openCircuitKeys ?? new Set<string>();

  const result: Partial<Record<EngineName, { route: RouteId; model: string | null; fallbackFrom: RouteId | null }>> = {};

  for (const engine of engines) {
    const order = routeOrder(engine, env);
    let chosen: RouteId | null = null;
    let fallbackFrom: RouteId | null = null;
    const eligibleRoutes: RouteId[] = [];

    for (let i = 0; i < order.length; i++) {
      const candidate = order[i];
      if (!isRouteConfigured(engine, candidate, env)) {
        continue;
      }
      if (candidate === "dataforseo") {
        const allowed =
          (await checkFeature("dataforseo_engines")) &&
          DATAFORSEO_APPROVED_ENGINES.includes(engine);
        if (!allowed) continue;
      }
      if (!isRouteScanCapable(engine, candidate)) {
        continue;
      }

      eligibleRoutes.push(candidate);
      const circuit = circuitIdentity(engine, env, { route: candidate });
      const circuitKey = hashIdentity(circuit);
      if (openKeys.has(circuitKey)) {
        continue;
      }

      chosen = candidate;
      fallbackFrom = candidate !== order[0] ? order[0] : null;
      break;
    }

    if (!chosen) {
      // If no route qualifies, the engine resolves to its first configured eligible route (so claim blocks with provider_circuit_open), or first in order
      chosen = eligibleRoutes[0] ?? order.find((r) => isRouteConfigured(engine, r, env)) ?? order[0];
      fallbackFrom = chosen !== order[0] ? order[0] : null;
    }

    let model: string | null = null;
    if (chosen === "dataforseo" && engine === "perplexity") {
      model = deps.resolveModel
        ? await deps.resolveModel(engine)
        : await resolveLatestLlmModelName("perplexity", { env });
    }

    result[engine] = {
      route: chosen,
      model,
      fallbackFrom,
    };
  }

  return result as Record<EngineName, { route: RouteId; model: string | null; fallbackFrom: RouteId | null }>;
}

export function requestBudgetMs(engine: EngineName, route: RouteId | undefined): number {
  if (route === "dataforseo") {
    if (DATAFORSEO_SCAN_MODES[engine] === "model_live") {
      return 100_000;
    }
    return 140_000;
  }
  return 70_000;
}

export function leaseSecondsFor(_engine: EngineName, route: RouteId | undefined): number {
  if (route === "dataforseo") {
    return 180;
  }
  return 120;
}

export function laneConcurrency(
  engine: EngineName,
  route: RouteId | undefined,
  env?: Record<string, string | undefined>,
): number {
  if (route === "dataforseo" && DATAFORSEO_SCAN_MODES[engine] === "model_live") {
    const raw = (env ?? process.env).DATAFORSEO_SCAN_MODEL_CONCURRENCY;
    const val = Number(raw);
    if (Number.isFinite(val) && val > 0) {
      return Math.min(6, Math.max(1, Math.floor(val)));
    }
    return 3;
  }
  return 1;
}
