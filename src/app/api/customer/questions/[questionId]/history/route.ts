import { AppError } from "../../../../../../shared/http/appError.ts";
import { jsonOk, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../server/workspace/requireWorkspace.ts";
import { getQuestionHistory, type HistoryDeps } from "../../../../../../server/questions/history/history.ts";
import { historyParams, historyQuery } from "../../../../../../server/questions/history/history.contract.ts";

export const dynamic = "force-dynamic";

export type QuestionHistoryRouteDeps = RequireWorkspaceDeps &
  HistoryDeps & {
    requireWorkspace?: typeof requireWorkspace;
    getQuestionHistory?: typeof getQuestionHistory;
  };

export async function GET(
  request: Request,
  context: { params: Promise<{ questionId: string }> },
  deps?: QuestionHistoryRouteDeps,
): Promise<Response> {
  try {
    const params = historyParams.safeParse(await context.params);
    if (!params.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.", { cause: params.error });
    }
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
    let engines: string[] | undefined;
    if (typeof raw.engines === "string" && raw.engines.length > 0) {
      engines = raw.engines.split(",");
    }
    const parsedQuery = historyQuery.safeParse({
      brand_key: raw.brand_key,
      from: raw.from,
      to: raw.to,
      engines: raw.engines,
    });
    if (!parsedQuery.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.", { cause: parsedQuery.error });
    }
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: parsedQuery.data.brand_key },
      deps,
    );
    const history = await (deps?.getQuestionHistory ?? getQuestionHistory)(
      workspace,
      params.data.questionId,
      { from: parsedQuery.data.from, to: parsedQuery.data.to, engines },
      deps,
    );
    return jsonOk(history, 200);
  } catch (error) {
    return toErrorResponse(error);
  }
}
