import { AppError } from "../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../server/workspace/requireWorkspace.ts";
import { clusterApplyBody } from "../../../../../../server/keywords/keywords.contract.ts";
import { jobStore } from "../../../../../../server/jobs/store.ts";
import { getJobStatus } from "../../../../../../server/jobs/status.ts";
import { createSavedKeywordsRepository } from "../../../../../../server/keywords/repository.ts";

export const dynamic = "force-dynamic";

export type ClusterApplyRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  jobStore?: typeof jobStore;
  getJobStatus?: typeof getJobStatus;
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
  deps?: ClusterApplyRouteDeps,
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

    const parsed = clusterApplyBody.safeParse(rawBody);
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
    if (!(await checkFlag("keyword_clustering", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }

    const store = (deps?.jobStore ?? jobStore)();
    const job = await store.getJob(body.jobId);
    if (!job || job.brand_key !== workspace.brandKey || job.kind !== "keywords.cluster") {
      throw new AppError(404, "job_not_found", "This job does not exist in this workspace.");
    }

    const statusFn = deps?.getJobStatus ?? getJobStatus;
    const status = await statusFn(body.jobId, { store });
    if (status.status !== "completed") {
      throw new AppError(409, "job_not_ready", "This job is not finished yet.");
    }

    const result = status.result as {
      clusters?: Array<{ savedKeywordIds: string[] }>;
    } | null;
    const proposalIds = new Set<string>();
    for (const c of result?.clusters ?? []) {
      for (const id of c.savedKeywordIds ?? []) proposalIds.add(id);
    }
    // validate every requested id appears in proposal
    for (const cluster of body.clusters) {
      for (const id of cluster.savedKeywordIds) {
        if (!proposalIds.has(id)) {
          throw new AppError(400, "invalid_request", "Keyword not in this proposal.");
        }
      }
    }

    const repo = createSavedKeywordsRepository(workspace.admin);
    let taggedCount = 0;
    const tags: Array<{ id: string; name: string }> = [];
    for (const cluster of body.clusters) {
      const res = await repo.updateTags({
        brandKey: workspace.brandKey,
        savedKeywordIds: cluster.savedKeywordIds,
        addTags: [{ name: cluster.name, normalized: cluster.name.trim().toLowerCase().replace(/\s+/g, " ") }],
      });
      taggedCount += res.taggedCount;
      for (const t of res.addedTags) {
        if (!tags.some((x) => x.id === t.id)) tags.push({ id: t.id, name: t.name });
      }
    }

    return json({ taggedCount, tags });
  } catch (err) {
    return toErrorResponse(err);
  }
}