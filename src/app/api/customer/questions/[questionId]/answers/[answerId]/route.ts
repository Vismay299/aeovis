import { AppError } from "../../../../../../../lib/http/appError.ts";
import { jsonOk, toErrorResponse } from "../../../../../../../lib/http/errors.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../../lib/workspace/requireWorkspace.ts";
import { getQuestionAnswer, type AnswerDeps } from "../../../../../../../lib/questions/history/answer.ts";
import { answerParams, answerQuery } from "../../../../../../../lib/questions/history/history.contract.ts";

export const dynamic = "force-dynamic";

export type QuestionAnswerRouteDeps = RequireWorkspaceDeps &
  AnswerDeps & {
    requireWorkspace?: typeof requireWorkspace;
    getQuestionAnswer?: typeof getQuestionAnswer;
  };

export async function GET(
  request: Request,
  context: { params: Promise<{ questionId: string; answerId: string }> },
  deps?: QuestionAnswerRouteDeps,
): Promise<Response> {
  try {
    const params = answerParams.safeParse(await context.params);
    if (!params.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.", { cause: params.error });
    }
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
    const parsedQuery = answerQuery.safeParse({ brand_key: raw.brand_key });
    if (!parsedQuery.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.", { cause: parsedQuery.error });
    }
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: parsedQuery.data.brand_key },
      deps,
    );
    const answer = await (deps?.getQuestionAnswer ?? getQuestionAnswer)(
      workspace,
      params.data.questionId,
      params.data.answerId,
      deps,
    );
    return jsonOk(answer, 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}
