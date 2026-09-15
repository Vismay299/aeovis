import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { runGscIngest } from "@/lib/gsc/ingest";

// Side-effectful (calls Google, writes gsc_daily) — never at build time.
export const dynamic = "force-dynamic";
// A first-run 90-day backfill pages through up to 250k rows per property.
export const maxDuration = 300;

const warnedNoSecret = { value: false };

/**
 * The status that carries a pass's report. 500 when the pass did nothing
 * useful — the connection list was unreadable, or every connected brand
 * failed — so the platform's cron failure alerting sees it. A pass with zero
 * connections is a measured zero and answers 200.
 */
export function gscCronStatus(report) {
  if (!report) return 500;
  if (report.connections > 0 && report.ok === 0) return 500;
  return 200;
}

/**
 * GET /api/gsc/worker — R4.1.1 weekly GSC ingest (vercel.json cron).
 * Same perimeter as the scan and content workers: the CRON_SECRET bearer is
 * the only credential (src/lib/cronAuth.js), and this path is SELF_GATED in
 * src/lib/operatorPerimeter.js so the middleware does not double-gate it.
 */
export async function GET(request, contextOrDeps = {}, maybeDeps = {}) {
  const deps =
    maybeDeps && Object.keys(maybeDeps).length > 0
      ? maybeDeps
      : contextOrDeps && !contextOrDeps.params
      ? contextOrDeps
      : {};
  const { searchParams } = new URL(request.url);

  if (!isCronAuthorized(request, searchParams, { label: "gsc-cron", warned: warnedNoSecret, env: deps.env })) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  const run = deps.runGscIngest ?? runGscIngest;
  try {
    const report = await run(deps);
    return NextResponse.json(report, { status: gscCronStatus(report) });
  } catch (error) {
    console.error("[gsc-cron] ingest could not run:", error);
    return NextResponse.json(
      { connections: null, ok: 0, failed: 0, rows_written: 0, results: [],
        unavailable: { reason: "connections_unreadable", detail: "Could not read gsc_connections — the ingest ran for NO brand." } },
      { status: 500 }
    );
  }
}
