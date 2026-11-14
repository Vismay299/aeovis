import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import { trackQuestionBody } from "../../../../../lib/keywords/keywords.contract.ts";
import {
  trackKeywordAsQuestion,
  type TrackKeywordAsQuestionDeps,
} from "../../../../../lib/keywords/trackQuestion.ts";

export const dynamic = "force-dynamic";

export type TrackQuestionRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  add?: TrackKeywordAsQuestionDeps["add"];
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
  deps?: TrackQuestionRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        throw new AppError(400, "invalid_json", "Invalid JSON request body.");
      }
    }

    const parsed = trackQuestionBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Check request fields and try again.",
        { cause: parsed.error },
      );
    }

    const body = parsed.data;
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brand_key },
      deps,
    );

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("question_curation", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const result = await trackKeywordAsQuestion(
      workspace.admin,
      {
        brandKey: workspace.brandKey,
        userId: workspace.user.id,
        keyword: body.keyword,
        text: body.text,
        topic: body.topic,
        locationCode: body.locationCode,
        languageCode: body.languageCode,
      },
      deps?.add ? { add: deps.add } : undefined,
    );

    return json({
      question: {
        id: result.question.id,
        text: result.question.text,
        status: result.question.status,
        topic: result.question.topic,
      },
      created: result.created,
      revived: result.revived,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
