import { z } from "zod";
import { definePricedAction, type PricingContext, type PricedActionEstimateResult } from "../pricedActions.ts";
import {
  type ExploreModel,
  exploreModelSchema,
  exploreModelLabel,
  countryLabel,
  EXPLORE_MAX_PROMPT_LENGTH,
  EXPLORE_MAX_HIGHLIGHT_BRAND_LENGTH,
} from "../../explore.ts";
import { toMicros, fromMicros } from "../../spend/money.ts";
import { resolveExploreRoutes, type ExploreRouteDecision } from "../../../server/explore/routes.ts";
import { hashPrompt } from "../../../server/explore/shape.ts";
import { createExploreStore, type ExploreRoute, type ReusableExploreObservation } from "../../../server/explore/store.ts";

export const exploreRunActionInput = z.strictObject({
  prompt: z.string().trim().min(1).max(EXPLORE_MAX_PROMPT_LENGTH),
  models: z.preprocess(
    (v) => (Array.isArray(v) ? Array.from(new Set(v)) : v),
    z.array(exploreModelSchema).min(1).max(3),
  ),
  webSearch: z.boolean().default(true),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .default(null),
  highlightBrand: z.string().trim().min(1).max(EXPLORE_MAX_HIGHLIGHT_BRAND_LENGTH).nullable().default(null),
  fresh: z.boolean().default(false),
});

export type ExploreRunActionInput = z.infer<typeof exploreRunActionInput>;

export type ExploreQuoteDeps = {
  dispatchControl?: (ctx: PricingContext) => Promise<{ paused?: boolean; brand_allowlist?: string[] | null } | null>;
  findReusable?: (params: {
    brandKey: string;
    promptHash: string;
    routes: ExploreRoute[];
    webSearch: boolean;
    country: string | null;
    days: number;
  }) => Promise<Map<ExploreModel, ReusableExploreObservation>>;
  resolveRoutes?: (params: {
    models: ExploreModel[];
    country?: string | null;
    webSearch?: boolean;
    env?: Record<string, string | undefined>;
    openCircuits?: Set<string> | string[];
    isFeatureEnabled?: (feature: string) => Promise<boolean> | boolean;
  }) => Promise<ExploreRouteDecision[]>;
};

async function defaultDispatchControl(
  ctx: PricingContext,
): Promise<{ paused?: boolean; brand_allowlist?: string[] | null } | null> {
  if (!ctx.admin || typeof ctx.admin.from !== "function") return null;
  try {
    const { data } = await ctx.admin
      .from("probe_dispatch_control")
      .select("paused, brand_allowlist")
      .eq("singleton", true)
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

export async function estimateExploreRun(
  ctx: PricingContext,
  input: ExploreRunActionInput,
  deps?: ExploreQuoteDeps,
): Promise<PricedActionEstimateResult> {
  let blocked: { code: string; message: string; recovery?: string } | null = null;

  // 1. Check dispatch pause fence
  const control = deps?.dispatchControl
    ? await deps.dispatchControl(ctx)
    : await defaultDispatchControl(ctx);

  if (control?.paused) {
    const allowlist = Array.isArray(control.brand_allowlist) ? control.brand_allowlist : [];
    if (!allowlist.includes(ctx.brandKey)) {
      blocked = {
        code: "collection_paused",
        message: "Answer collection is paused for maintenance, so this question cannot be asked now.",
      };
    }
  }

  // 2. Resolve routes
  const routeDecisions = deps?.resolveRoutes
    ? await deps.resolveRoutes({
        models: input.models,
        country: input.country,
        webSearch: input.webSearch,
        env: ctx.env,
      })
    : await resolveExploreRoutes({
        models: input.models,
        country: input.country,
        webSearch: input.webSearch,
        env: ctx.env,
      });

  const routesForStore: ExploreRoute[] = routeDecisions.map((d) => ({
    model: d.model,
    route: d.route,
    modelName: d.modelName,
  }));

  // 3. Check reusable answers
  let reusableMap = new Map<ExploreModel, ReusableExploreObservation>();
  if (!input.fresh) {
    const promptHash = hashPrompt(input.prompt);
    const days = Number(ctx.env.EXPLORE_REUSE_DAYS || 7);

    if (deps?.findReusable) {
      reusableMap = await deps.findReusable({
        brandKey: ctx.brandKey,
        promptHash,
        routes: routesForStore,
        webSearch: input.webSearch,
        country: input.country,
        days,
      });
    } else if (ctx.admin && typeof ctx.admin.from === "function") {
      try {
        const store = createExploreStore(ctx.admin);
        reusableMap = await store.findReusable({
          brandKey: ctx.brandKey,
          promptHash,
          routes: routesForStore,
          webSearch: input.webSearch,
          country: input.country,
          days,
          now: ctx.now,
        });
      } catch {
        reusableMap = new Map();
      }
    }
  }

  // 4. Build line items
  const lines: Array<{ label: string; quantity: number; unitUsd: number; totalUsd: number }> = [];
  let totalMicros = 0;
  let reusedCount = 0;
  let activeCount = 0;

  for (const model of input.models) {
    const decision = routeDecisions.find((d) => d.model === model);
    const label = exploreModelLabel(model);

    if (!input.fresh && reusableMap.has(model)) {
      reusedCount += 1;
      lines.push({
        label: `${label} · reused (last 7 days)`,
        quantity: 1,
        unitUsd: 0,
        totalUsd: 0,
      });
    } else if (decision?.skipped === "UNSUPPORTED_COUNTRY") {
      const cName = countryLabel(input.country);
      lines.push({
        label: `${label} · skipped (not available for ${cName})`,
        quantity: 0,
        unitUsd: 0,
        totalUsd: 0,
      });
    } else if (decision?.skipped === "NOT_AVAILABLE" || !decision?.route) {
      lines.push({
        label: `${label} · skipped`,
        quantity: 0,
        unitUsd: 0,
        totalUsd: 0,
      });
    } else {
      activeCount += 1;
      const unitUsd = decision.reserveUsd;
      totalMicros += toMicros(unitUsd);
      lines.push({
        label: `${label} · up to $${unitUsd.toFixed(2)}`,
        quantity: 1,
        unitUsd,
        totalUsd: unitUsd,
      });
    }
  }

  // 5. Blocked check: no models available
  if (activeCount === 0 && reusedCount === 0 && !blocked) {
    blocked = {
      code: "no_models_available",
      message: "None of the selected models can answer right now. Choose another model or try again later.",
    };
  }

  const totalUsd = fromMicros(totalMicros);

  return {
    totalUsd,
    expectedUsd: null,
    units: [
      { key: "models", label: "models", count: input.models.length },
      { key: "reused", label: "reused answers", count: reusedCount },
    ],
    lines,
    monthly: null,
    warnings: [
      {
        code: "cost_note",
        message: "You pay only the provider's charge for each answer, up to this amount.",
      },
    ],
    blocked,
  };
}

export const exploreRunAction = definePricedAction({
  key: "ai_visibility.explore.run",
  feature: "ai_visibility.explore",
  input: exploreRunActionInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateExploreRun(ctx, input),
});
