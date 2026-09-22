import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { pruneNoopScanRuns } from "@/lib/scanRunsRetention";

// Deletes rows — never at build time.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const warnedNoSecret = { value: false };

/**
 * GET /api/scan-runs/retention — R1.2.23(a) daily 30-day retention for the
 * fleet's idle `noop` rows in `scan_runs` (vercel.json cron, 03:30 UTC, half an
 * hour after the evidence sweep so the two never share a window).
 *
 * Same perimeter as the workers and /api/evidence/retention: the CRON_SECRET
 * bearer is the only credential, and the path is SELF_GATED in
 * src/lib/operatorPerimeter.js.
 *
 * WHY A NON-OK REPORT IS A 500 AND NOT A 200 WITH A SAD BODY
 * `pruneNoopScanRuns` never throws for a failed delete; it returns
 * `deleted: null` plus a reason, because an unmeasured pass must be
 * distinguishable from a measured zero in the payload itself. But a cron that
 * answers 200 is a cron nobody looks at again, so the honest report is returned
 * WITH a 500 status whenever the pass did not complete — the body says what
 * happened, the status makes the platform say it out loud.
 */
export async function GET(request, contextOrDeps = {}, maybeDeps = {}) {
  const deps =
    maybeDeps && Object.keys(maybeDeps).length > 0
      ? maybeDeps
      : contextOrDeps && !contextOrDeps.params
      ? contextOrDeps
      : {};
  const { searchParams } = new URL(request.url);
  if (!isCronAuthorized(request, searchParams, { label: "scan-runs-retention", warned: warnedNoSecret })) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  try {
    const report = await (deps.pruneNoopScanRuns ?? pruneNoopScanRuns)(deps);
    if (!report || report.ok !== true) {
      console.error("[scan-runs-retention] pass did not complete:", report?.reason);
      return NextResponse.json(report ?? { ok: false, deleted: null, reason: "no report" }, { status: 500 });
    }
    return NextResponse.json(report);
  } catch (error) {
    console.error("[scan-runs-retention] pass failed:", error);
    return NextResponse.json(
      {
        ok: false,
        deleted: null,
        reason: `Scan-runs retention did not complete — expired idle rows may remain: ${error.message}`,
      },
      { status: 500 }
    );
  }
}
