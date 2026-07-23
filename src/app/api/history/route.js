import { NextResponse } from "next/server";
import { listRecentScans } from "@/lib/db";
import { listContentItems, listContentJobs } from "@/lib/db/content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RUNNING = ["pending", "coordinating", "researching", "benchmarking", "drafting", "reviewing"];

/**
 * GET /api/history — the homepage workspace: the latest scan per brand, the
 * most recent content runs, and any in-flight agent jobs. Single-operator
 * model, so this is unscoped (matches the rest of the app).
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
      { scans, runs, activeJobs, counts },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("History API error:", error);
    return NextResponse.json({ scans: [], runs: [], activeJobs: [], counts: {} }, { status: 200 });
  }
}
