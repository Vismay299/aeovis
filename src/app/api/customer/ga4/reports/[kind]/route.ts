import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import { runReport } from "../../../../../../lib/ga4/reporting.ts";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GA4_REPORT_KINDS = [
  "landing_pages",
  "page_performance",
  "key_events",
  "traffic_acquisition",
  "ecommerce_performance",
  "site_search",
  "audience_breakdown",
] as const;

const reportsQuery = z.strictObject({
  brand_key: z.string().optional(),
  range: z.enum(["last_7_days", "last_28_days", "last_90_days"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  channel: z.enum(["organic_search", "all"]).optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
  includeDate: z.coerce.boolean().optional(),
  breakdown: z.enum(["event", "event_and_landing_page"]).optional(),
  acquisitionBreakdown: z.enum(["channel_group", "source_medium", "campaign"]).optional(),
  ecommerceBreakdown: z.enum(["item", "landing_page"]).optional(),
  ecommerceOnlyWithTransactions: z.coerce.boolean().optional(),
  audienceBreakdown: z.enum(["device", "country", "new_vs_returning"]).optional(),
  comparePreviousPeriod: z.coerce.boolean().optional(),
});

export type Ga4ReportsRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  runReport?: typeof runReport;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(
  request: Request,
  ctx: { params: { kind: string } } | any,
  deps?: Ga4ReportsRouteDeps,
): Promise<Response> {
  try {
    const kind = ctx?.params?.kind;
    if (!GA4_REPORT_KINDS.includes(kind as any)) {
      throw new AppError(404, "invalid_request", "Unknown report kind.");
    }

    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v;
    const parsed = reportsQuery.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.");
    }
    const q = parsed.data;
    const workspace = await requireWorkspace(request, { brandKey: q.brand_key }, deps);
    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const fn = deps?.runReport ?? runReport;
    const result = await fn(
      workspace.admin,
      { brandKey: workspace.brandKey, user: workspace.user, role: workspace.role },
      {
        kind: kind as any,
        range: q.range,
        startDate: q.startDate,
        endDate: q.endDate,
        channel: q.channel,
        limit: q.limit,
        offset: q.offset,
        includeDate: q.includeDate,
        breakdown: q.breakdown,
        acquisitionBreakdown: q.acquisitionBreakdown,
        ecommerceBreakdown: q.ecommerceBreakdown,
        ecommerceOnlyWithTransactions: q.ecommerceOnlyWithTransactions,
        audienceBreakdown: q.audienceBreakdown,
        comparePreviousPeriod: q.comparePreviousPeriod,
      },
    );
    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}