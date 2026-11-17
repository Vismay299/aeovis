import { z } from "zod";
import { isCronAuthorized } from "../../../../server/cronAuth.js";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import { AppError, jsonOk, toErrorResponse } from "../../../../shared/http/errors.ts";
import { keepAlive } from "../../../../server/keepAlive.js";
import "../../../../server/jobs/kinds.ts";
import { runTick } from "../../../../server/jobs/tick.ts";
import type { TickReport } from "../../../../server/jobs/tick.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export type TickRouteDeps = {
  isCronAuthorized?: typeof isCronAuthorized;
  isFeatureEnabled?: typeof isFeatureEnabled;
  keepAlive?: typeof keepAlive;
  runTick?: (input: { jobId?: string; startedAt: number }) => Promise<TickReport>;
  warned?: { value: boolean };
  now?: () => number;
};

const warned = { value: false };
const jobIdSchema = z.uuid();

async function tick(request: Request, deps: TickRouteDeps = {}): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const startedAt = (deps.now ?? Date.now)();

  try {
    const authorized = (deps.isCronAuthorized ?? isCronAuthorized)(request, searchParams, {
      label: "jobs-tick",
      warned: deps.warned ?? warned,
    });
    if (!authorized) return jsonOk({ error: "Unauthorized", code: "unauthorized" }, 401);

    if (!(await (deps.isFeatureEnabled ?? isFeatureEnabled)("jobs_tick"))) {
      return jsonOk({ skipped: "disabled" });
    }

    const raw = searchParams.get("job_id");
    const jobId = raw === null || raw === "" ? undefined : raw;
    if (jobId !== undefined && !jobIdSchema.safeParse(jobId).success) {
      throw new AppError(400, "invalid_request", "The request was not valid.");
    }

    // Returned before the work finishes: pg_net gives up after 5 s, the work does not.
    const work = (deps.runTick ?? runTick)({ jobId, startedAt });
    (deps.keepAlive ?? keepAlive)(work, { label: "jobs-tick" });
    return jsonOk({ accepted: true }, 202);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const GET = tick;
export const POST = tick;
