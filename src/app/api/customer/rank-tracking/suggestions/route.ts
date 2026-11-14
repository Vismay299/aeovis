import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { suggestKeywordsForDomain } from "../../../../../lib/rank-tracking/suggestions.ts";
import { isLabsLocationCode } from "../../../../../shared/keyword-locations.ts";
import { requireApprovedPrice } from "../../../../../lib/pricing/pricedActions.ts";
import { toResearchError } from "../../../../../lib/research/providerErrors.ts";
import "../../../../../lib/pricing/actions/index.ts";

export const dynamic = "force-dynamic";

const schema = z.strictObject({
  brand_key: z.string().optional(),
  domain: z.string().trim().min(1).max(253),
  locationCode: z.number().int().positive(),
  languageCode: z.string().min(2).max(8).optional(),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

export type SuggestionsRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  suggestKeywordsForDomain?: typeof suggestKeywordsForDomain;
};

export async function POST(request: Request, _ctx?: unknown, deps?: SuggestionsRouteDeps): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    if (!isLabsLocationCode(input.locationCode)) {
      throw new AppError(422, "suggestions_unavailable", "Ranked-keyword suggestions aren't available for this country. Add the keywords you want to track manually.");
    }
    if (input.cacheOnly) {
      const out = await (deps?.suggestKeywordsForDomain ?? suggestKeywordsForDomain)(ws as any, {
        domain: input.domain,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        cacheOnly: true,
        requestId: input.requestId,
      });
      if (out === null) {
        return Response.json({ keywords: null, cached: true, fetchedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
      }
      return Response.json({ keywords: out.keywords, cached: out.cached, fetchedAt: out.fetchedAt }, { headers: { "cache-control": "no-store" } });
    }
    const pricingCtx = { brandKey: ws.brandKey, admin: ws.admin, env: process.env, now: new Date() };
    const approved = await (deps?.requireApprovedPrice ?? requireApprovedPrice)(
      "rank_tracking.suggestions.run",
      pricingCtx as any,
      { domain: input.domain, locationCode: input.locationCode, languageCode: input.languageCode },
      input.maxUsd,
    );
    const out = await (deps?.suggestKeywordsForDomain ?? suggestKeywordsForDomain)(ws as any, {
      domain: input.domain,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      maxUsd: approved.approvedMaxUsd,
      cacheOnly: false,
      requestId: input.requestId,
    });
    if (out === null) {
      return Response.json({ keywords: null, cached: true, fetchedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ keywords: out.keywords, cached: out.cached, fetchedAt: out.fetchedAt }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(
      toResearchError(err, {
        unavailableCode: "rank_suggestions_unavailable",
        unavailableMessage: "Ranking keywords could not be loaded. You can add keywords manually.",
      }),
    );
  }
}
