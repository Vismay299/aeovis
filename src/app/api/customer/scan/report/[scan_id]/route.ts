/**
 * F03 §6.5 — `GET /api/customer/scan/report/[scan_id]`.
 *
 * The route existed before F03 and kept its URL, its body and its copy: the
 * only change is additive. `scan.cost` is the scan's cost, and each result row
 * gains its own `cost`, joined by `results[i].raw.observation_id`.
 *
 * The workspace is resolved with `requireWorkspace`, and the scan's own
 * `brand_key` is the workspace that owns it — so a member of several
 * workspaces keeps access to all of them, and a scan belonging to another
 * workspace answers exactly like a scan that does not exist.
 *
 * The customer-visible strings are the route's own, byte for byte: the
 * conversion to `requireWorkspace` + `toErrorResponse` must not change what a
 * customer reads.
 */

import { AppError, jsonOk, toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { requireWorkspace } from "../../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { getAnswerCosts, getScanCost, unavailableScanCost } from "../../../../../../lib/costs/scanCost.ts";
import type { AnswerCost, ScanCost } from "../../../../../../lib/costs/types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ scan_id: string }> };

/** The dependencies a test (or a future caller) may replace. */
export type ScanReportRouteDeps = RequireWorkspaceDeps & {
  getScanCost?: typeof getScanCost;
  getAnswerCosts?: typeof getAnswerCosts;
};

/** This route's own copy. Not one word of it changed in the conversion. */
const MESSAGES = {
  missingScanId: "scan_id is required.",
  notFound: "Scan not found.",
  serverNotConfigured: "Server is not configured.",
  workspaceAccess: "Could not load your workspace access.",
  loadFailed: "Could not load the scan report.",
} as const;

type ScanRow = {
  id: string;
  brand: string | null;
  url: string | null;
  scanned_at: string | null;
  created_at: string | null;
  visibility_pct: number | null;
  prompts_tracked: number | null;
  prompts_mentioned: number | null;
  platform: unknown;
  raw_results: Record<string, unknown> | null;
  origin_job_id: string | null;
  brand_key: string | null;
};

type ResultRow = {
  id: string;
  query: string;
  engine: string;
  answer_text: string | null;
  answered: boolean | null;
  mentioned: boolean | null;
  brand_cited: boolean | null;
  position: number | null;
  sentiment: string | null;
  raw: Record<string, unknown> | null;
  created_at: string | null;
};

/**
 * `requireWorkspace` speaks its own copy; this route answers with its own.
 * The codes are the standard ones, so a client can still branch on them.
 */
function legacyWorkspaceError(err: unknown): AppError | null {
  if (!(err instanceof AppError)) return null;
  switch (err.code) {
    case "unauthenticated":
      return new AppError(401, "unauthenticated", "Please sign in.");
    case "auth_not_configured":
      return new AppError(503, "auth_not_configured", "Customer login is not configured.");
    case "membership_unavailable":
      return new AppError(503, "membership_unavailable", MESSAGES.workspaceAccess);
    case "storage_unavailable":
      return new AppError(503, "storage_unavailable", MESSAGES.serverNotConfigured);
    case "workspace_not_found":
      return new AppError(404, "scan_not_found", MESSAGES.notFound);
    default:
      return null;
  }
}

/**
 * The error's name and message, bounded. A database failure is PostgREST's
 * plain `{message, code, details, hint}` object rather than an `Error`, so its
 * message is read directly.
 */
function describeFailure(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 200)}`;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string") return `Error: ${message.slice(0, 200)}`;
  return typeof err;
}

/**
 * A failure log: the route, the scan id and the error's name and message —
 * never the payload, the answer text, the query, the headers or the brand key
 * (conventions §6 rule 9). The pre-F03 route logged every failure this way.
 */
function logFailure(stage: string, scanId: string | undefined, err: unknown): void {
  console.error(
    `[customer] ${stage} failed for ${scanId ?? "unknown"}:`,
    describeFailure(err)
  );
}

/**
 * The session and the storage transport come from the aliased modules, so a
 * test can substitute them without this route knowing.
 */
async function resolveDeps(deps?: ScanReportRouteDeps): Promise<RequireWorkspaceDeps> {
  const resolved: RequireWorkspaceDeps = { ...deps };
  if (!resolved.getCustomerContext) {
    const customer = await import("@/lib/supabase/customer");
    resolved.getCustomerContext = customer.getCustomerContext as RequireWorkspaceDeps["getCustomerContext"];
  }
  if (!resolved.getSupabaseAdmin) {
    const admin = await import("@/lib/supabase/admin");
    resolved.getSupabaseAdmin = admin.getSupabaseAdmin;
  }
  return resolved;
}

/**
 * The scan's cost and the per-answer costs.
 *
 * A 404 `scan_not_found` from the cost read is NOT a tenant violation: the
 * route has already authorised the scan, so it only means this scan has no
 * usable dispatch ledger (no job row, or a job that is not this workspace's).
 * The report still reads — with the cost unavailable, never zeros.
 *
 * Any other failure is a database failure, and it answers this route's own
 * 500 copy. It is never degraded into "unavailable": that would hide a real
 * failure behind a "no data" state.
 */
async function readCosts(
  admin: SupabaseClient,
  scanId: string,
  jobId: string | null,
  brandKey: string,
  deps: ScanReportRouteDeps
): Promise<{ cost: ScanCost; answerCosts: Map<string, AnswerCost> }> {
  try {
    const cost = await (deps.getScanCost ?? getScanCost)(admin, jobId, brandKey);
    const answerCosts = jobId
      ? await (deps.getAnswerCosts ?? getAnswerCosts)(admin, jobId, brandKey)
      : new Map<string, AnswerCost>();
    return { cost, answerCosts };
  } catch (err) {
    if (err instanceof AppError && err.status === 404 && err.code === "scan_not_found") {
      // Not a failure: the route has already authorised the scan, so this only
      // means it has no usable dispatch ledger. Nothing is logged for it.
      return {
        cost: unavailableScanCost(jobId),
        answerCosts: new Map<string, AnswerCost>(),
      };
    }
    logFailure("scan report (cost read)", scanId, err);
    throw new AppError(500, "internal_error", MESSAGES.loadFailed);
  }
}

export async function GET(
  request: Request,
  context: RouteContext,
  deps?: ScanReportRouteDeps
): Promise<Response> {
  // Hoisted so the outer catch can name the scan in its log.
  let scanId: string | undefined;
  try {
    const params = await context.params;
    scanId = params?.scan_id;
    if (!scanId) throw new AppError(400, "invalid_request", MESSAGES.missingScanId);

    const workspaceDeps = await resolveDeps(deps);

    // The session is checked first, so an anonymous caller cannot tell an
    // existing scan from a missing one.
    let workspace;
    try {
      workspace = await requireWorkspace(request, {}, workspaceDeps);
    } catch (err) {
      throw legacyWorkspaceError(err) ?? err;
    }
    const admin = workspace.admin;

    const { data, error } = await admin.from("scans").select("*").eq("id", scanId).maybeSingle();
    if (error) {
      logFailure("scan report (scans read)", scanId, error);
      throw new AppError(500, "internal_error", MESSAGES.loadFailed);
    }
    const scan = (data ?? null) as ScanRow | null;
    if (!scan || !scan.brand_key) throw new AppError(404, "scan_not_found", MESSAGES.notFound);

    // The scan names the workspace that owns it. A member of several
    // workspaces keeps access to all of them; a scan from another workspace
    // answers exactly like a scan that does not exist.
    if (scan.brand_key !== workspace.brandKey) {
      try {
        workspace = await requireWorkspace(request, { brandKey: scan.brand_key }, workspaceDeps);
      } catch (err) {
        throw legacyWorkspaceError(err) ?? err;
      }
    }

    const { data: resultRows, error: resultsError } = await admin
      .from("prompt_results")
      .select("id, query, engine, answer_text, answered, mentioned, brand_cited, position, sentiment, raw, created_at")
      .eq("scan_id", scanId)
      .order("created_at", { ascending: true });
    if (resultsError) {
      logFailure("scan report (prompt results read)", scanId, resultsError);
      throw new AppError(500, "internal_error", MESSAGES.loadFailed);
    }
    const results = (resultRows ?? []) as ResultRow[];

    const jobId = scan.origin_job_id ?? null;
    const { cost, answerCosts } = await readCosts(admin, scanId, jobId, scan.brand_key, deps ?? {});

    return jsonOk({
      scan: {
        id: scan.id,
        brand: scan.brand,
        url: scan.url,
        scanned_at: scan.scanned_at,
        created_at: scan.created_at,
        visibility_pct: scan.visibility_pct,
        summary_stats: scan.raw_results?.summary_stats ?? null,
        prompts_tracked: scan.prompts_tracked,
        prompts_mentioned: scan.prompts_mentioned,
        platform: scan.platform,
        engines: scan.raw_results?.engines || null,
        planned_questions: scan.raw_results?.planned_questions || null,
        engine_scores: scan.raw_results?.engine_scores || null,
        competitors: scan.raw_results?.competitors || [],
        share_of_voice_pct: scan.raw_results?.share_of_voice_pct ?? null,
        win_rate_pct: scan.raw_results?.win_rate_pct ?? null,
        brand_citation_share_pct: scan.raw_results?.brand_citation_share_pct ?? null,
        cost,
      },
      results: results.map((row) => {
        const observationId = (row.raw?.observation_id as string | undefined) ?? null;
        const answer = observationId ? answerCosts.get(observationId) : undefined;
        return {
          ...row,
          cost: answer
            ? { usd: answer.usd, attempts: answer.attempts, unknownAttempts: answer.unknownAttempts }
            : null,
        };
      }),
    });
  } catch (err) {
    // A deliberate answer (an `AppError` the route raised on purpose) is not a
    // failure: the reads above log their own failures. Anything else is a bug
    // or a transport failure, and it must be visible.
    if (!(err instanceof AppError)) logFailure("scan report", scanId, err);
    return toErrorResponse(err);
  }
}
