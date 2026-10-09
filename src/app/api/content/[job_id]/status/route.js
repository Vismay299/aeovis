import { NextResponse } from "next/server";
import { getContentJob, listContentRunsForJob } from "@/lib/db/content";
import { JOB_STAGES } from "@/lib/content/stages";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/content/[job_id]/status — poll a content job (mirrors scan status). */
export async function GET(request, { params }) {
  params = await params;
  try {
    const { job_id } = params;
    if (!job_id) {
      return NextResponse.json({ detail: "Job ID is required." }, { status: 400 });
    }

    const job = await getContentJob(job_id);
    if (!job) {
      return NextResponse.json({ detail: "Job not found." }, { status: 404 });
    }

    // Per-block execution ledger (T3) — where the per-item budget actually
    // went. Fail-soft: an unavailable ledger must not break status polling.
    const runs = await listContentRunsForJob(job_id);
    const stage = JOB_STAGES[job.status] || null;

    return NextResponse.json(
      {
        id: job.id,
        brand: job.brand,
        playbook: job.playbook,
        status: job.status,
        stage_kind: stage?.kind || null,
        terminal: !!stage?.terminal,
        progress_pct: job.progress_pct,
        item_id: job.item_id,
        error_message: job.error_message,
        cost_total: job.cost_total,
        agent_snapshot: job.agent_snapshot || null,
        agent_trace: job.agent_trace || [],
        input: job.input || {},
        created_at: job.created_at,
        runs: runs.map((r) => ({
          block: r.block,
          cycle: r.cycle,
          status: r.status,
          cost: Number(r.cost) || 0,
          tokens: r.tokens || 0,
          duration_ms: r.duration_ms,
          error: r.error || null,
        })),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (error) {
    console.error("Error retrieving content job status:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
