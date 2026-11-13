// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import { keywordResearchRequestBody } from "../../../../../lib/keywords/keywords.contract.ts";
import {
  research,
  researchCacheInput,
  type ResearchDeps,
} from "../../../../../lib/keywords/research.ts";
import { peekCached } from "../../../../../lib/research/cache.ts";
import {
  normalizeKeyword,
  toMetricUpsertRow,
} from "../../../../../lib/keywords/helpers.ts";
import {
  researchKey,
  resolveResearchMarket,
} from "../../../../../lib/keywords/market.ts";
import { upsertKeywordMetrics } from "../../../../../lib/keywords/metricsStore.ts";
import {
  requireApprovedPrice,
  type PricingContext,
} from "../../../../../lib/pricing/pricedActions.ts";
import "../../../../../lib/pricing/actions/index.ts";
import { createLabsClient } from "../../../../../lib/providers/dataforseo/labs.ts";
import { createGoogleAdsClient } from "../../../../../lib/providers/dataforseo/google-ads.ts";
import { assertLocalResearchLocation } from "../../../../../lib/keywords/localVolume.ts";
import { appendResearch } from "../../../../../lib/projectContext/service.ts";
import { toResearchError } from "../../../../../lib/research/providerErrors.ts";
import { keepAlive as defaultKeepAlive } from "../../../../../lib/keepAlive.js";
import type { CacheDeps } from "../../../../../lib/cache/providerCache.ts";

export const dynamic = "force-dynamic";

export type ResearchRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  labs?: ResearchDeps["labs"];
  ads?: ResearchDeps["ads"];
  upsertMetrics?: ResearchDeps["upsertMetrics"];
  assertLocalLocation?: ResearchDeps["assertLocalLocation"];
  requireApprovedPrice?: typeof requireApprovedPrice;
  appendResearch?: typeof appendResearch;
  cacheDeps?: CacheDeps;
};

const UNAVAILABLE_MESSAGE = "This page is not available for your workspace yet.";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: ResearchRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }

    const parsed = keywordResearchRequestBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        "Check request fields and try again.",
        { cause: parsed.error },
      );
    }

    const input = parsed.data;
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: input.brand_key },
      deps,
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("keyword_research", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const seed = normalizeKeyword(input.keyword);
    if (!seed) {
      throw new AppError(400, "invalid_request", "Seed keyword cannot be empty.");
    }

    const market = resolveResearchMarket(
      { locationCode: input.locationCode, languageCode: input.languageCode },
      workspace.brand,
    );

    const cacheInput = researchCacheInput({
      keyword: seed,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      resultLimit: input.resultLimit,
      mode: input.mode,
      clickstream: input.clickstream,
      groupKeywords: input.groupKeywords,
      locationName: input.locationName ?? null,
    });

    if (input.cacheOnly) {
      const peek = await peekCached(
        cacheInput,
        deps?.cacheDeps ? { cacheDeps: deps.cacheDeps } : undefined,
      );
      if (peek) {
        return json({
          ...peek.value,
          cached: true,
          fetchedAt: peek.fetchedAt,
        });
      }
      return json({ notCached: true, cached: false });
    }

    // Check cache before spending
    const peek = await peekCached(
      cacheInput,
      deps?.cacheDeps ? { cacheDeps: deps.cacheDeps } : undefined,
    );
    if (peek) {
      return json({
        ...peek.value,
        cached: true,
        fetchedAt: peek.fetchedAt,
      });
    }

    // Cache miss - require price approval before running live
    const pricingCtx: PricingContext = {
      brandKey: workspace.brandKey,
      admin: workspace.admin,
      env: process.env,
      now: new Date(),
    };

    const approvePrice =
      deps?.requireApprovedPrice ?? requireApprovedPrice;
    const approval = await approvePrice(
      "keywords.research.run",
      pricingCtx,
      {
        keyword: seed,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        locationName: input.locationName,
        resultLimit: input.resultLimit,
        mode: input.mode,
        clickstream: input.clickstream,
        groupKeywords: input.groupKeywords,
      },
      input.maxUsd,
    );

    const labs = deps?.labs ?? createLabsClient();
    const ads = deps?.ads ?? createGoogleAdsClient();
    const upsertMetrics =
      deps?.upsertMetrics ??
      (async (rows, mkt) => {
        if (!workspace.admin) return;
        const upsertRows = rows.map((r) =>
          toMetricUpsertRow(r, mkt, "labs"),
        );
        await upsertKeywordMetrics(workspace.admin, upsertRows);
      });

    const res = await research(
      {
        keyword: seed,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        locationName: input.locationName,
        resultLimit: input.resultLimit,
        mode: input.mode,
        clickstream: input.clickstream,
        groupKeywords: input.groupKeywords,
      },
      {
        labs,
        ads,
        upsertMetrics,
        // F13-AC-20: an area outside the country registry is refused before
        // any paid call.
        assertLocalLocation:
          deps?.assertLocalLocation ??
          ((code, name) => assertLocalResearchLocation(code, name)),
        requestId: input.requestId ?? crypto.randomUUID(),
        maxUsd: approval.approvedMaxUsd,
        brandKey: workspace.brandKey,
        keepAlive: defaultKeepAlive,
        cachedDeps: deps?.cacheDeps ? { cacheDeps: deps.cacheDeps } : undefined,
      },
    );

    if (!res.cached && workspace.admin) {
      const appendFn = deps?.appendResearch ?? appendResearch;
      const researchKeyStr = researchKey({
        seed,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        locationName: input.locationName,
      });
      await appendFn(workspace.admin, {
        brandKey: workspace.brandKey,
        kind: "keywords.research",
        researchKey: researchKeyStr,
        summary: `Researched “${seed}”: ${res.result.rows.length} keywords found.`,
        author: "system",
        actorUserId: workspace.user?.id ?? null,
      }).catch(() => {});
    }

    return json({
      ...res.result,
      cached: res.cached,
      fetchedAt: res.fetchedAt,
    });
  } catch (err) {
    const mapped = toResearchError(err, {
      unavailableCode: "research_unavailable",
      unavailableMessage:
        "Keyword research is temporarily unavailable. Try again shortly.",
    });
    return toErrorResponse(mapped);
  }
}
