import { AppError } from "../../../../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../../../../lib/http/errors.ts";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../../../../../../../../../lib/features/flags.ts";
import { requireWorkspace as defaultRequireWorkspace } from "../../../../../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { trackKeywordAsAiQuestion as defaultTrackKeywordAsAiQuestion } from "../../../../../../../../../lib/rank-tracking/aiQuestions.ts";

export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  brand_key: z.string().optional(),
  text: z.string().trim().min(2).max(1500),
  topic: z.string().trim().max(120).optional(),
});

function parseConfigId(raw: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  }
  return raw;
}

function parseKeywordId(raw: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new AppError(404, "keyword_not_found", "This tracked keyword does not exist.");
  }
  return raw;
}

export type RouteDeps = {
  requireWorkspace?: typeof defaultRequireWorkspace;
  isFeatureEnabled?: typeof defaultIsFeatureEnabled;
  trackKeywordAsAiQuestion?: typeof defaultTrackKeywordAsAiQuestion;
  admin?: any;
};

export async function POST(
  request: Request,
  ctx: { params: Promise<{ configId: string; keywordId: string }> },
  deps?: RouteDeps,
) {
  try {
    const rawParams = await ctx.params;
    const configId = parseConfigId(rawParams?.configId);
    const keywordId = parseKeywordId(rawParams?.keywordId);

    let rawJson: unknown;
    try {
      rawJson = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON body.");
    }

    const parseRes = bodySchema.safeParse(rawJson);
    if (!parseRes.success) {
      throw new AppError(400, "invalid_request", parseRes.error.issues[0]?.message ?? "Invalid body");
    }
    const body = parseRes.data;

    const requireWs = deps?.requireWorkspace ?? defaultRequireWorkspace;
    const ws = await requireWs(request, { brandKey: body.brand_key });

    const isFeatureOn = deps?.isFeatureEnabled ?? defaultIsFeatureEnabled;
    const [rtOn, aiqOn] = await Promise.all([
      isFeatureOn("rank_tracking", ws.brandKey),
      isFeatureOn("rank_tracking_ai_questions", ws.brandKey),
    ]);

    if (!rtOn || !aiqOn) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const trackFn = deps?.trackKeywordAsAiQuestion ?? defaultTrackKeywordAsAiQuestion;
    const admin = deps?.admin ?? ws.admin;

    const result = await trackFn(
      ws,
      configId,
      keywordId,
      { text: body.text, topic: body.topic },
      { admin },
    );

    return Response.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store", "content-type": "application/json" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
