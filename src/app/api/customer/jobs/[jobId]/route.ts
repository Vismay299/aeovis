import { AppError, jsonOk, toErrorResponse } from "../../../../../shared/http/errors.ts";
import { jobIdParams, jobStatusQuery } from "../../../../../server/jobs/jobs.contract.ts";
import { jobStore } from "../../../../../server/jobs/store.ts";
import type { JobStore } from "../../../../../server/jobs/store.ts";
import { getJobStatus } from "../../../../../server/jobs/status.ts";
import type { JobStatusResult } from "../../../../../server/jobs/status.ts";
import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ jobId: string }> };

export type JobStatusRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  store?: JobStore;
  getJobStatus?: (jobId: string) => Promise<JobStatusResult>;
};

export async function GET(request: Request, context: RouteContext, deps: JobStatusRouteDeps = {}): Promise<Response> {
  try {
    // The declared query is a strictObject, so an unknown parameter is a 400
    // rather than something the route silently drops.
    const query = jobStatusQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const params = jobIdParams.parse(await context.params);

    const workspace = await (deps.requireWorkspace ?? requireWorkspace)(request, { brandKey: query.brand_key });
    const store = deps.store ?? jobStore();
    const job = await store.getJob(params.jobId);
    // A system job and another workspace's job answer identically, so a caller
    // cannot learn that a job id exists outside its own workspace.
    if (!job || job.brand_key === null || job.brand_key !== workspace.brandKey) {
      throw new AppError(404, "job_not_found", "This job does not exist in this workspace.");
    }

    const status = await (deps.getJobStatus ?? ((jobId: string) => getJobStatus(jobId, { store })))(params.jobId);
    return jsonOk({
      jobId: job.id,
      kind: job.kind,
      trigger: job.trigger,
      ...status,
      // Postgres renders `+00:00`, which jobStatusResponse's z.iso.datetime() rejects.
      createdAt: new Date(job.created_at).toISOString(),
      finishedAt: job.finished_at === null ? null : new Date(job.finished_at).toISOString(),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
