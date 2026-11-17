import { NextResponse } from "next/server";
import { listRecentScans } from "@/server/db";
import { listContentItems, listContentJobs } from "@/server/db/content";
import { historyStoreUnreachable } from "@/shared/historyStoreState";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RUNNING = ["pending", "coordinating", "researching", "benchmarking", "drafting", "reviewing"];

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/history — the homepage workspace: the latest scan per brand, the
 * most recent content runs, and any in-flight agent jobs. Single-operator
 * model, so this is unscoped (matches the rest of the app); the operator
 * perimeter in src/middleware.js gates it, it is not a public route.
 *
 * THE ONE THING THIS HANDLER MUST NEVER DO (R2.8.16): answer a refusal with 200
 * and empty collections. listRecentScans throws ScansUnavailableError rather
 * than guessing, and this catch used to turn that into
 * `200 { scans: [], runs: [], activeJobs: [], counts: {} }` — indistinguishable
 * from a real first run, so the refusal reached the server log and nobody else.
 * The contract, the 503 and the reason vocabulary live in
 * src/shared/historyStoreState.js, shared with the surface that renders it.
 */
export async function GET() {
  try {
    const [scans, items, jobs] = await Promise.all([
      listRecentScans(12),
      listContentItems(),
      listContentJobs(undefined, 40),
    ]);

    const runs = (items || []).slice(0, 12).map((i) => ({
      id: i.id,
      brand: i.brand,
      title: i.title,
      status: i.status,
      agent_name: i.agent_snapshot?.name || (i.playbook === "linkedin_post" ? "LinkedIn CXO" : "GEO Citation Writer"),
      agent_emoji: i.agent_snapshot?.emoji || (i.playbook === "linkedin_post" ? "💼" : "📄"),
      format: i.agent_snapshot?.format || (i.playbook === "linkedin_post" ? "linkedin_post" : "article"),
      rubric_verdict: i.rubric?.verdict || null,
      updated_at: i.updated_at,
    }));

    const activeJobs = (jobs || [])
      .filter((j) => RUNNING.includes(j.status))
      .slice(0, 8)
      .map((j) => ({
        id: j.id,
        brand: j.brand,
        status: j.status,
        progress_pct: j.progress_pct,
        agent_name: j.agent_snapshot?.name || j.playbook,
        agent_emoji: j.agent_snapshot?.emoji || "🤖",
      }));

    const counts = {
      brands: scans.length,
      runs: (items || []).length,
      awaiting: (items || []).filter((i) => i.status === "awaiting_approval").length,
      active_jobs: activeJobs.length,
    };

    return NextResponse.json(
      { store: "ok", reason: null, scans, runs, activeJobs, counts },
      { headers: NO_STORE }
    );
  } catch (error) {
    // The upstream message stays here, in the server log, where an operator can
    // read it. It must not travel to the client.
    console.error("History API error:", error);
    const { status, body } = historyStoreUnreachable(error);
    return NextResponse.json(body, { status, headers: NO_STORE });
  }
}
