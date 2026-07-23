import { NextResponse } from "next/server";
import { getContentJob } from "@/lib/db/content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/content/[job_id]/status — poll a content job (mirrors scan status). */
export async function GET(request, { params }) {
  try {
    const { job_id } = params;
    if (!job_id) {
      return NextResponse.json({ detail: "Job ID is required." }, { status: 400 });
    }

    const job = await getContentJob(job_id);
    if (!job) {
      return NextResponse.json({ detail: "Job not found." }, { status: 404 });
    }

    return NextResponse.json(
      {
        id: job.id,
        brand: job.brand,
        playbook: job.playbook,
        status: job.status,
        progress_pct: job.progress_pct,
        item_id: job.item_id,
        error_message: job.error_message,
        cost_total: job.cost_total,
        created_at: job.created_at,
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
