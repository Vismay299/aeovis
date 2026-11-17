import { AppError, jsonOk, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { cancelJob } from "../../../../../../server/jobs/cancel.ts";
import type { CancelOutcome } from "../../../../../../server/jobs/cancel.ts";
import { jobCancelBody, jobIdParams } from "../../../../../../server/jobs/jobs.contract.ts";
import { jobStore } from "../../../../../../server/jobs/store.ts";
import type { JobStore } from "../../../../../../server/jobs/store.ts";
import { requireWorkspace } from "../../../../../../server/workspace/requireWorkspace.ts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ jobId: string }> };

export type JobCancelRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  store?: JobStore;
  cancelJob?: (jobId: string, deps?: { store?: JobStore }) => Promise<CancelOutcome>;
};

/**
 * Same answer as `readJsonBody` (400 `invalid_json`, not a 500), for a body the
 * route has already read as text so the empty body can still mean `{}`.
 */
function readBody(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be JSON.");
  }
}

export async function POST(request: Request, context: RouteContext, deps: JobCancelRouteDeps = {}): Promise<Response> {
  try {
    const body = jobCancelBody.parse(readBody(await request.text()));
    const params = jobIdParams.parse(await context.params);

    const workspace = await (deps.requireWorkspace ?? requireWorkspace)(request, { brandKey: body.brand_key });
    const store = deps.store ?? jobStore();
    const job = await store.getJob(params.jobId);
    if (!job || job.brand_key === null || job.brand_key !== workspace.brandKey) {
      throw new AppError(404, "job_not_found", "This job does not exist in this workspace.");
    }

    const status = await (deps.cancelJob ?? cancelJob)(params.jobId, { store });
    return jsonOk({ jobId: job.id, status });
  } catch (err) {
    return toErrorResponse(err);
  }
}
