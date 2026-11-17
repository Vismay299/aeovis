import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/server/cronAuth";
import { pruneProbeEvidence } from "@/server/evidenceRetention";

// Deletes Storage objects — never at build time.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const warnedNoSecret = { value: false };

/**
 * GET /api/evidence/retention — R1.5.1 daily 90-day retention for the
 * `probe-evidence` bucket (vercel.json cron). Same perimeter as the workers:
 * the CRON_SECRET bearer is the only credential, and the path is SELF_GATED in
 * src/server/operatorPerimeter.js. A pass that could not list or remove answers
 * 500 so platform cron alerting sees it.
 */
export async function GET(request, contextOrDeps = {}, maybeDeps = {}) {
  const deps =
    maybeDeps && Object.keys(maybeDeps).length > 0
      ? maybeDeps
      : contextOrDeps && !contextOrDeps.params
      ? contextOrDeps
      : {};
  const { searchParams } = new URL(request.url);
  if (!isCronAuthorized(request, searchParams, { label: "evidence-retention", warned: warnedNoSecret })) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  try {
    const report = await (deps.pruneProbeEvidence ?? pruneProbeEvidence)(deps);
    return NextResponse.json(report);
  } catch (error) {
    console.error("[evidence-retention] pass failed:", error);
    return NextResponse.json(
      { ran: false, detail: "Evidence retention did not complete — expired objects may remain." },
      { status: 500 }
    );
  }
}
