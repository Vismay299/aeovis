import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { requireApprovedPrice, recordApproval } from "../../../../../shared/pricing/pricedActions.ts";
import "../../../../../shared/pricing/actions/index.ts";
import {
  snapshotTargetCreateRequestBody,
  snapshotTargetsQuery,
} from "../../../../../server/backlinks/backlinks.contract.ts";
import {
  createSnapshotTarget,
  listSnapshotTargets,
  snapshotSkipMessage,
} from "../../../../../server/backlinks/snapshots.ts";
import { normalizeBacklinksTarget } from "../../../../../shared/providers/dataforseo/backlinksTarget.ts";
import { computeNextRunAt } from "../../../../../shared/schedule.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type SnapshotTargetsRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  requireApprovedPrice?: typeof requireApprovedPrice;
  recordApproval?: typeof recordApproval;
  createSnapshotTarget?: typeof createSnapshotTarget;
  listSnapshotTargets?: typeof listSnapshotTargets;
  computeNextRunAt?: typeof computeNextRunAt;
  randomUUID?: () => string;
};

function query(request: Request) {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = snapshotTargetsQuery.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
  return parsed.data;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function requireSnapshotWorkspace(
  request: Request,
  brandKey: string | undefined,
  deps?: SnapshotTargetsRouteDeps,
  owner = false,
) {
  const workspace = await requireWorkspace(request, { brandKey, ...(owner ? { role: "owner" as const } : {}) }, deps);
  const flag = deps?.isFeatureEnabled ?? isFeatureEnabled;
  if (!(await flag("backlinks", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
  }
  if (!(await flag("backlink_snapshots", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
  }
  return workspace;
}

export async function GET(request: Request, _ctx?: unknown, deps?: SnapshotTargetsRouteDeps): Promise<Response> {
  try {
    const input = query(request);
    const workspace = await requireSnapshotWorkspace(request, input.brand_key, deps);
    const targets = await (deps?.listSnapshotTargets ?? listSnapshotTargets)(workspace.admin, workspace.brandKey);
    return json({
      targets: targets.map((row) => ({
        id: row.id,
        target: row.target,
        scope: row.scope,
        label: row.label,
        interval: row.schedule_interval,
        enabled: row.enabled,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastSkipReason: row.last_skip_reason,
        lastSkipMessage: row.last_skip_reason ? snapshotSkipMessage(row.last_skip_reason) : null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, _ctx?: unknown, deps?: SnapshotTargetsRouteDeps): Promise<Response> {
  try {
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new AppError(400, "invalid_request", "The request body must be JSON."); }
    const parsed = snapshotTargetCreateRequestBody.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check the highlighted fields and try again.");
    const input = parsed.data;
    const queryInput = query(request);
    const workspace = await requireSnapshotWorkspace(request, queryInput.brand_key, deps, true);
    const normalized = normalizeBacklinksTarget(input.target, { scope: input.scope });
    if (normalized.scope !== input.scope || normalized.path !== "") {
      throw new AppError(400, "invalid_target", "Enter a domain to track backlink history.");
    }
    const approved = await (deps?.requireApprovedPrice ?? requireApprovedPrice)(
      "backlinks.snapshots.track",
      { brandKey: workspace.brandKey, admin: workspace.admin, env: process.env, now: new Date() },
      { target: input.target, scope: input.scope, interval: input.interval },
      input.maxUsd,
    );
    const targetId = deps?.randomUUID ? deps.randomUUID() : crypto.randomUUID();
    const approvalId = await (deps?.recordApproval ?? recordApproval)(workspace.admin, {
      brandKey: workspace.brandKey,
      action: "backlinks.snapshots.track",
      approvedMaxUsd: approved.approvedMaxUsd,
      quote: approved.quote,
      source: "schedule",
      subject: { kind: "backlink_snapshot_target", id: targetId },
      approvedBy: workspace.user.id,
    });
    const created = await (deps?.createSnapshotTarget ?? createSnapshotTarget)(workspace.admin, {
      id: targetId,
      brandKey: workspace.brandKey,
      target: normalized.apiTarget,
      scope: input.scope,
      interval: input.interval,
      label: input.label,
      approvedMaxUsd: approved.approvedMaxUsd,
      approvalId,
      createdBy: workspace.user.id,
      nextRunAt: (deps?.computeNextRunAt ?? computeNextRunAt)(input.interval, null),
    });
    return json({ target: {
      id: created.id,
      target: created.target,
      scope: created.scope,
      label: created.label,
      interval: created.schedule_interval,
      enabled: created.enabled,
      nextRunAt: created.next_run_at,
      lastRunAt: created.last_run_at,
      lastSkipReason: created.last_skip_reason,
      lastSkipMessage: created.last_skip_reason ? snapshotSkipMessage(created.last_skip_reason) : null,
    } }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}
