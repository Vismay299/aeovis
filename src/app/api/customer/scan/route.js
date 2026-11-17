import { requireWorkspace } from "../../../../server/workspace/requireWorkspace.ts";
import { toErrorResponse, jsonOk, AppError } from "../../../../shared/http/errors.ts";
import { requireApprovedPrice } from "../../../../shared/pricing/pricedActions.ts";
import "../../../../shared/pricing/actions/index.ts";
import { startCustomerScan } from "../../../../shared/pricing/startCustomerScan.ts";
import { scanRouteBody } from "../../../../shared/pricing/scanRoute.contract.ts";
import { captureServerEvent } from "../../../../shared/telemetry/server.ts";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * The request body. Legacy callers (the owner demo script) may POST with no
 * body at all, which the old route accepted as `{}`; a body that is present
 * but is not JSON is still a 400.
 */
async function readScanBody(request) {
  let text = "";
  try {
    text = await request.text();
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be JSON.");
  }
}

// Next.js calls a route handler as (request, { params }); `deps` is the third
// argument so the route context is never mistaken for test dependencies.
export async function POST(request, _ctx, deps) {
  try {
    const raw = await readScanBody(request);

    const parsed = scanRouteBody.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid scan request", {
        details: parsed.error.issues,
      });
    }
    const body = parsed.data;
    const competitors = (body?.competitors || "").trim();
    const industry = (body?.industry || "").trim();

    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const workspace = await loadWorkspace(request, { brandKey: body.brand_key }, deps);
    const ctx = {
      brandKey: workspace.brandKey,
      admin: workspace.admin,
      env: deps?.env ?? process.env,
      now: deps?.now ? deps.now() : new Date(),
    };

    const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
    let approval;
    try {
      approval = await approveFn(
        "ai_visibility.scan.run",
        ctx,
        { panelKey: body.panel_key ?? "default" },
        body.maxUsd,
      );
    } catch (err) {
      if (err instanceof AppError && err.code === "panel_not_approved") {
        return jsonOk(
          { error: "Review and approve a question panel before starting measurement.", code: "panel_not_approved" },
          409,
        );
      }
      throw err;
    }

    const startScanFn = deps?.startCustomerScan ?? startCustomerScan;
    const result = await startScanFn(
      {
        admin: workspace.admin,
        brandKey: workspace.brandKey,
        userId: workspace.user?.id,
        quote: approval.quote,
        approvedMaxUsd: approval.approvedMaxUsd,
        source: approval.source,
        panelKey: body.panel_key ?? "default",
        brandDisplayName: workspace.brand.display_name,
        url: workspace.brand.website || "",
        legacy: {
          industry,
          competitors,
        },
      },
      deps,
    );

    const response = jsonOk(
      {
        job_id: result.jobId,
        brand: workspace.brand.display_name,
        status: "pending",
        approvedMaxUsd: result.approvedMaxUsd,
        quotedUsd: result.quotedUsd,
      },
      201,
    );

    // F26 §6.2.7 `scan:started`: after the 201, never before it, and never able
    // to change the response.
    try {
      void captureServerEvent({
        name: "scan:started",
        props: { approved_usd: result.approvedMaxUsd ?? null },
        userId: workspace.user?.id ?? null,
        brandKey: workspace.brandKey,
      }).catch(() => {});
    } catch {
      // Telemetry never changes the response.
    }
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request, _ctx, deps) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("brand_key") || undefined;
    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const workspace = await loadWorkspace(request, { brandKey: key }, deps);

    const { data: scans, error } = await workspace.admin
      .from("scans")
      .select(
        "id, brand, url, scanned_at, created_at, visibility_pct, prompts_tracked, prompts_mentioned, platform, engine_summaries:raw_results->engines",
      )
      .eq("brand_key", workspace.brandKey)
      .order("scanned_at", { ascending: false, nullsFirst: false })
      .limit(20);

    if (error) throw error;

    const { data: jobs, error: jobsError } = await workspace.admin
      .from("scan_jobs")
      .select("id, brand, url, status, progress_pct, created_at, error_message")
      .eq("brand_key", workspace.brandKey)
      .order("created_at", { ascending: false })
      .limit(10);

    if (jobsError) throw jobsError;

    return jsonOk({
      brand_key: workspace.brandKey,
      scans: (scans || []).map(({ engine_summaries, ...row }) => {
        const summaries =
          engine_summaries && typeof engine_summaries === "object"
            ? engine_summaries
            : null;
        const names = Array.isArray(summaries)
          ? summaries
              .map((slice) => slice?.engine || slice?.name)
              .filter(Boolean)
          : summaries
            ? Object.keys(summaries)
            : [];
        const slices = summaries ? Object.values(summaries) : [];
        return {
          ...row,
          platform: names.length ? names : row.platform,
          collection_partial: slices.some(
            (slice) =>
              slice?.data_source_issue === true ||
              (typeof slice?.error_rate_pct === "number" &&
                slice.error_rate_pct > 0),
          ),
        };
      }),
      jobs: jobs || [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
