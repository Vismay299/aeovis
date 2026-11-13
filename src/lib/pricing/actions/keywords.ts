import { z } from "zod";
import {
  definePricedAction,
  type PricingContext,
  type PricedActionEstimateResult,
} from "../pricedActions.ts";
import { dataforseoPricing } from "../dataforseo.ts";
import {
  getKeywordDataProvider,
  LOCATION_OPTIONS,
  getIsoCountryCode,
  formatLocationLabel,
} from "../../../shared/keyword-locations.ts";
import { fetchSerpLocationsForCountry } from "../../providers/dataforseo/serp-locations.ts";
import { normalizeKeyword } from "../../keywords/helpers.ts";
import { researchKey, resolveResearchMarket } from "../../keywords/market.ts";
import { estimateClusterPromptChars } from "../../keywords/clustering.ts";
import { getLlmModel } from "../../llmConfig.js";
import { estimateLlmUsd } from "../../llm/openrouter.ts";
import { findRecentResearch } from "../../projectContext/service.ts";
import {
  createSavedKeywordsRepository,
  type SavedKeywordsRepository,
} from "../../keywords/repository.ts";

export const keywordResearchActionInput = z.strictObject({
  keyword: z.string().trim().min(1).max(200),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  locationName: z.string().min(1).max(200).optional(),
  resultLimit: z.union([z.literal(150), z.literal(300), z.literal(500)]).default(150),
  mode: z.enum(["auto", "related", "suggestions", "ideas"]).default("auto"),
  clickstream: z.boolean().default(false),
  groupKeywords: z.boolean().default(false),
});

export const serpRunActionInput = z.strictObject({
  keyword: z.string().trim().min(1).max(200),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  locationName: z.string().min(1).max(200).optional(),
  depth: z.union([z.literal(20), z.literal(100)]).default(20),
});

export type KeywordQuoteDeps = {
  brandHost?: (brandKey: string) => Promise<string>;
  findRecentResearch?: typeof findRecentResearch;
  fetchSerpLocations?: typeof fetchSerpLocationsForCountry;
};

async function loadBrandHost(
  ctx: PricingContext,
  deps?: KeywordQuoteDeps,
): Promise<string> {
  if (deps?.brandHost) return deps.brandHost(ctx.brandKey);
  if (!ctx.admin?.from) return "example.com";
  try {
    const { data } = await ctx.admin
      .from("brands")
      .select("website_host")
      .eq("brand_key", ctx.brandKey)
      .maybeSingle();
    return data?.website_host ?? "example.com";
  } catch {
    return "example.com";
  }
}

function round6(val: number): number {
  return Math.round(val * 1e6) / 1e6;
}

export async function estimateKeywordResearch(
  ctx: PricingContext,
  input: z.infer<typeof keywordResearchActionInput>,
  deps?: KeywordQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const seed = normalizeKeyword(input.keyword);
  const host = await loadBrandHost(ctx, deps);
  const market = resolveResearchMarket(
    { locationCode: input.locationCode, languageCode: input.languageCode },
    { website_host: host },
  );

  if (input.locationName) {
    try {
      const locations = await (
        deps?.fetchSerpLocations ?? fetchSerpLocationsForCountry
      )(getIsoCountryCode(market.locationCode));
      if (!locations.some((loc) => loc.locationName === input.locationName)) {
        const country =
          LOCATION_OPTIONS.find((opt) => opt.code === market.locationCode)
            ?.label ?? "this country";
        return {
          totalUsd: 0,
          expectedUsd: 0,
          units: [{ key: "results", label: "keyword ideas", count: input.resultLimit }],
          lines: [],
          monthly: null,
          warnings: [],
          blocked: {
            code: "unknown_location",
            message: `"${formatLocationLabel(input.locationName)}" is not a city, county, or region we can find in ${country}.`,
          },
        };
      }
    } catch {
      // If the registry cannot be loaded, don't block pricing; runtime handles it.
    }
  }

  const provider = getKeywordDataProvider(market.locationCode);
  const L = input.resultLimit;
  const clickstream = provider === "google_ads" ? false : input.clickstream;
  const lines: Array<{
    label: string;
    quantity: number;
    unitUsd: number;
    totalUsd: number;
  }> = [];

  let fallbackCost = 0;

  if (provider === "google_ads") {
    const ideasCost = round6(dataforseoPricing.keywords.adsIdeas({}));
    lines.push({
      label: "Keyword ideas from Google Ads",
      quantity: 1,
      unitUsd: ideasCost,
      totalUsd: ideasCost,
    });
  } else if (input.mode === "auto") {
    const half = Math.ceil(L / 2);
    const suggCost = round6(
      dataforseoPricing.keywords.suggestions({
        limit: half,
        includeClickstreamData: clickstream,
      }),
    );
    lines.push({
      label: "Phrase-match ideas",
      quantity: 1,
      unitUsd: suggCost,
      totalUsd: suggCost,
    });

    const ideasCost = round6(
      dataforseoPricing.keywords.ideas({
        limit: half,
        includeClickstreamData: clickstream,
      }),
    );
    lines.push({
      label: "Category ideas",
      quantity: 1,
      unitUsd: ideasCost,
      totalUsd: ideasCost,
    });

    fallbackCost = round6(
      dataforseoPricing.keywords.related({
        limit: L,
        includeClickstreamData: clickstream,
      }),
    );
    lines.push({
      label: "Related keywords (only if the first two find fewer than 5)",
      quantity: 1,
      unitUsd: fallbackCost,
      totalUsd: fallbackCost,
    });
  } else {
    const cost = round6(
      dataforseoPricing.keywords[input.mode]({
        limit: L,
        includeClickstreamData: clickstream,
      }),
    );
    lines.push({
      label: "Keyword ideas",
      quantity: 1,
      unitUsd: cost,
      totalUsd: cost,
    });
  }

  if (input.locationName) {
    const localCost = round6(
      dataforseoPricing.keywords.adsSearchVolume({}),
    );
    lines.push({
      label: `Local volume for ${input.locationName}`,
      quantity: 1,
      unitUsd: localCost,
      totalUsd: localCost,
    });
  }

  // Always: Top 20 Google results for seed
  const serpCost = round6(
    dataforseoPricing.serp.live({
      depth: 20,
      keyword: seed,
    }),
  );
  lines.push({
    label: `Top 20 Google results for “${seed}”`,
    quantity: 1,
    unitUsd: serpCost,
    totalUsd: serpCost,
  });

  const totalUsd = round6(
    lines.reduce((sum, line) => sum + line.totalUsd, 0),
  );
  const expectedUsd =
    provider === "labs" && input.mode === "auto"
      ? round6(totalUsd - fallbackCost)
      : totalUsd;

  const warnings: Array<{ code: string; message: string }> = [
    {
      code: "cache_note",
      message:
        "Searching the same keyword, market and options again within 24 hours is free.",
    },
  ];

  if (provider === "google_ads") {
    warnings.push({
      code: "ads_only",
      message:
        "Keyword data for this country comes from Google Ads: no difficulty or intent.",
    });
  }

  if (ctx.admin) {
    const findRecent = deps?.findRecentResearch ?? findRecentResearch;
    const researchKeyStr = researchKey({
      seed,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      locationName: input.locationName,
    });
    try {
      const recent = await findRecent(ctx.admin, {
        brandKey: ctx.brandKey,
        kind: "keywords.research",
        researchKey: researchKeyStr,
      });
      if (recent) {
        const summaryText = recent.summary ?? "";
        warnings.push({
          code: "recent_research",
          message: `You researched this on ${recent.entryDate}: ${summaryText} Results older than 24 hours are bought again.`,
        });
      }
    } catch {
      // Ignore research log lookup failures
    }
  }

  return {
    totalUsd,
    expectedUsd,
    units: [{ key: "results", label: "keyword ideas", count: L }],
    lines,
    monthly: null,
    warnings,
    blocked: null,
  };
}

export async function estimateSerpRun(
  _ctx: PricingContext,
  input: z.infer<typeof serpRunActionInput>,
): Promise<PricedActionEstimateResult> {
  const seed = normalizeKeyword(input.keyword);
  const depth = input.depth;
  const cost = dataforseoPricing.serp.live({
    depth,
    keyword: seed,
  });

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "results", label: "SERP results", count: depth }],
    lines: [
      {
        label: `Top ${depth} Google results`,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings: [
      {
        code: "cache_note",
        message:
          "Results for the same keyword and market are reused for 12 hours.",
      },
    ],
    blocked: null,
  };
}

export const keywordResearchAction = definePricedAction({
  key: "keywords.research.run",
  feature: "keywords.research",
  input: keywordResearchActionInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateKeywordResearch(ctx, input),
});

export const serpRunAction = definePricedAction({
  key: "keywords.serp.run",
  feature: "keywords.serp",
  input: serpRunActionInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateSerpRun(ctx, input),
});

export const metricsRefreshActionInput = z.strictObject({});

async function defaultCheckRefreshRunning(ctx: PricingContext): Promise<boolean> {
  if (!ctx.admin || typeof ctx.admin.from !== "function") return false;
  try {
    const { data } = await ctx.admin
      .from("jobs")
      .select("id")
      .eq("single_active_key", `keywords.refresh:${ctx.brandKey}`)
      .in("status", ["queued", "running"])
      .limit(1)
      .maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}

export async function estimateMetricsRefresh(
  ctx: PricingContext,
  _input: z.infer<typeof metricsRefreshActionInput>,
  deps?: KeywordQuoteDeps & {
    repo?: SavedKeywordsRepository;
    isRefreshRunning?: (ctx: PricingContext) => Promise<boolean>;
  },
): Promise<PricedActionEstimateResult> {
  const isRunning = await (deps?.isRefreshRunning ?? defaultCheckRefreshRunning)(ctx);
  if (isRunning) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [
        { key: "stale", label: "stale keywords", count: 0 },
        { key: "fresh", label: "fresh keywords", count: 0 },
      ],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "refresh_running",
        message: "Keyword stats are already updating.",
      },
    };
  }

  const repo = deps?.repo ?? (ctx.admin ? createSavedKeywordsRepository(ctx.admin) : null);
  if (!repo) {
    throw new Error("Repository is unavailable.");
  }

  const startedAt = new Date().toISOString();
  const before = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { markets, fresh } = await repo.staleMarkets(ctx.brandKey, before, startedAt);

  let totalStale = 0;
  let totalUsd = 0;
  const lines: Array<{
    label: string;
    quantity: number;
    unitUsd: number;
    totalUsd: number;
  }> = [];

  for (const m of markets) {
    totalStale += m.stale;
    const provider = getKeywordDataProvider(m.locationCode);
    const country =
      LOCATION_OPTIONS.find((opt) => opt.code === m.locationCode)?.label ??
      "Unknown";
    const label = `${m.stale} keywords in ${country} (${m.batches} request${m.batches === 1 ? "" : "s"})`;

    let marketUsd = 0;
    if (provider === "google_ads") {
      marketUsd = round6(m.batches * dataforseoPricing.keywords.adsSearchVolume({}));
    } else {
      let sum = 0;
      for (let i = 0; i < m.batches; i++) {
        const remaining = m.stale - i * 700;
        const count = Math.max(1, Math.min(700, remaining));
        sum += dataforseoPricing.labs.keywordOverview({
          keywords: new Array(count),
        });
      }
      marketUsd = round6(sum);
    }

    totalUsd = round6(totalUsd + marketUsd);
    lines.push({
      label,
      quantity: m.batches,
      unitUsd: round6(marketUsd / m.batches),
      totalUsd: marketUsd,
    });
  }

  if (totalStale === 0) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [
        { key: "stale", label: "stale keywords", count: 0 },
        { key: "fresh", label: "fresh keywords", count: fresh },
      ],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "nothing_to_refresh",
        message: "Every saved keyword was updated in the last 7 days.",
      },
    };
  }

  return {
    totalUsd,
    expectedUsd: totalUsd,
    units: [
      { key: "stale", label: "stale keywords", count: totalStale },
      { key: "fresh", label: "fresh keywords", count: fresh },
    ],
    lines,
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export const metricsRefreshAction = definePricedAction({
  key: "keywords.metrics_refresh.run",
  feature: "keywords.metrics_refresh",
  input: metricsRefreshActionInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateMetricsRefresh(ctx, input),
});

export const clusteringActionInput = z.strictObject({
  savedKeywordIds: z.array(z.string().uuid()).min(1).max(500),
});

export async function estimateClustering(
  ctx: PricingContext,
  input: z.infer<typeof clusteringActionInput>,
  deps?: KeywordQuoteDeps & {
    repo?: SavedKeywordsRepository;
  },
): Promise<PricedActionEstimateResult> {
  const repo = deps?.repo ?? (ctx.admin ? createSavedKeywordsRepository(ctx.admin) : null);
  if (!repo) {
    throw new Error("Repository is unavailable.");
  }

  const listed = await repo.list({ brandKey: ctx.brandKey, pageSize: 5000 });
  const idSet = new Set(input.savedKeywordIds);
  const rows = listed.rows.filter((r) => idSet.has(r.id));

  if (rows.length < 10) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [{ key: "keywords", label: "keywords", count: rows.length }],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "too_few_keywords",
        message: "Select at least 10 keywords to group into topics.",
      },
    };
  }

  const model = getLlmModel(ctx.env);
  const chars = estimateClusterPromptChars(rows.map((r) => ({ keyword: r.keyword })));
  const cost = estimateLlmUsd(model, chars + 4000, 8000, ctx.env);

  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "keywords", label: "keywords", count: rows.length }],
    lines: [
      {
        label: `AI topic grouping for ${rows.length} keywords`,
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export const clusteringAction = definePricedAction({
  key: "keywords.clustering.run",
  feature: "keywords.clustering",
  input: clusteringActionInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateClustering(ctx, input),
});
