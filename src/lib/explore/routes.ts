// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-search/services/promptExplorer.ts:104-182
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  type ExploreModel,
  exploreModelLabel,
  countryLabel,
  supportsWebSearchCountry,
} from "../../shared/explore.ts";
import { llmResponseUsd, type LlmResponseModelSlug } from "../../shared/ai-visibility-pricing.ts";
import {
  getOpenRouterEngineModel,
  isOpenRouterEngineConfigured,
} from "../engines/openRouterProbe.js";
import { circuitIdentity } from "../engines/providerReadiness.js";
import { hashIdentity } from "../db/probeDispatch.js";
import { FALLBACK_MODEL_NAMES } from "../providers/dataforseo/llm-models.ts";

export type ExploreRouteId = "dataforseo" | "openrouter";

export type ExploreRouteDecision = {
  model: ExploreModel;
  route: ExploreRouteId | null;
  modelName: string | null;
  reserveUsd: number;
  skipped: "UNSUPPORTED_COUNTRY" | "NOT_AVAILABLE" | null;
  skipReason?: string | null;
};

export function getExploreOpenRouterReserveUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EXPLORE_OPENROUTER_RESERVE_USD;
  if (raw === undefined || raw === "") return 0.10;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid EXPLORE_OPENROUTER_RESERVE_USD: ${raw}`);
  }
  return parsed;
}

function modelToDfsSlug(model: ExploreModel): LlmResponseModelSlug {
  if (model === "chatgpt") return "chat_gpt";
  return model;
}

export function defaultDfsModelName(model: ExploreModel, env: Record<string, string | undefined> = process.env): string {
  if (model === "chatgpt") {
    return env.DATAFORSEO_LLM_MODEL_CHAT_GPT || FALLBACK_MODEL_NAMES.chat_gpt[0];
  }
  if (model === "gemini") {
    return env.DATAFORSEO_LLM_MODEL_GEMINI || FALLBACK_MODEL_NAMES.gemini[0];
  }
  if (model === "perplexity") {
    return env.DATAFORSEO_LLM_MODEL_PERPLEXITY || FALLBACK_MODEL_NAMES.perplexity[0];
  }
  return model;
}

export async function resolveExploreModelRoute(params: {
  model: ExploreModel;
  country?: string | null;
  webSearch?: boolean;
  env?: Record<string, string | undefined>;
  openCircuits?: Set<string> | string[];
  isFeatureEnabled?: (feature: string) => Promise<boolean> | boolean;
}): Promise<ExploreRouteDecision> {
  const env = params.env ?? process.env;
  const country = params.country ?? null;
  const webSearch = params.webSearch ?? true;
  const openCircuits = new Set(Array.isArray(params.openCircuits) ? params.openCircuits : params.openCircuits ?? []);

  // 1. Country support check
  if (webSearch && country) {
    if (params.model === "gemini") {
      return {
        model: params.model,
        route: null,
        modelName: null,
        reserveUsd: 0,
        skipped: "UNSUPPORTED_COUNTRY",
        skipReason: "Gemini doesn’t support country selection. Select “No country preference” above, then run again to include Gemini.",
      };
    }
    if (!supportsWebSearchCountry(params.model, country)) {
      const cLabel = countryLabel(country);
      const mLabel = exploreModelLabel(params.model);
      return {
        model: params.model,
        route: null,
        modelName: null,
        reserveUsd: 0,
        skipped: "UNSUPPORTED_COUNTRY",
        skipReason: `${mLabel} doesn’t support ${cLabel} as a search country. Select “No country preference” above, then run again to include ${mLabel}.`,
      };
    }
  }

  // 2. DataForSEO route check
  const dfsFlag =
    typeof params.isFeatureEnabled === "function"
      ? await params.isFeatureEnabled("dataforseo_engines")
      : String(env.FEATURE_DATAFORSEO_ENGINES ?? "").trim().toLowerCase() === "on";

  const dfsKey = String(env.DATAFORSEO_API_KEY ?? "").trim();
  const dfsCircuit = circuitIdentity(params.model, env, { route: "dataforseo" });
  const dfsCircuitKey = hashIdentity(dfsCircuit);
  const dfsCircuitOpen = openCircuits.has(dfsCircuitKey);

  if (dfsFlag && dfsKey && !dfsCircuitOpen) {
    const slug = modelToDfsSlug(params.model);
    const modelName = defaultDfsModelName(params.model, env);
    const reserveUsd = llmResponseUsd(slug, webSearch);
    return {
      model: params.model,
      route: "dataforseo",
      modelName,
      reserveUsd,
      skipped: null,
    };
  }

  // 3. OpenRouter fallback check
  const orConfigured = isOpenRouterEngineConfigured(params.model, env);
  const orCircuit = circuitIdentity(params.model, env, { route: "openrouter" });
  const orCircuitKey = hashIdentity(orCircuit);
  const orCircuitOpen = openCircuits.has(orCircuitKey);

  if (orConfigured && !orCircuitOpen) {
    const modelName = getOpenRouterEngineModel(params.model, env);
    const reserveUsd = getExploreOpenRouterReserveUsd(env);
    return {
      model: params.model,
      route: "openrouter",
      modelName,
      reserveUsd,
      skipped: null,
    };
  }

  // 4. Neither route available
  return {
    model: params.model,
    route: null,
    modelName: null,
    reserveUsd: 0,
    skipped: "NOT_AVAILABLE",
    skipReason: "None of the routes for this model are available.",
  };
}

export async function resolveExploreRoutes(params: {
  models: ExploreModel[];
  country?: string | null;
  webSearch?: boolean;
  env?: Record<string, string | undefined>;
  openCircuits?: Set<string> | string[];
  isFeatureEnabled?: (feature: string) => Promise<boolean> | boolean;
}): Promise<ExploreRouteDecision[]> {
  return Promise.all(
    params.models.map((model) =>
      resolveExploreModelRoute({
        model,
        country: params.country,
        webSearch: params.webSearch,
        env: params.env,
        openCircuits: params.openCircuits,
        isFeatureEnabled: params.isFeatureEnabled,
      }),
    ),
  );
}
