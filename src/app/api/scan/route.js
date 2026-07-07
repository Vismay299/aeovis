import { NextResponse } from "next/server";
import { createScanJob } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";

export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    const url = (payload.url || "").trim();
    const industry = (payload.industry || "").trim();
    const competitors = (payload.competitors || "").trim();
    const querySource = payload.querySource || "llm_generated";
    const gscQueries = Array.isArray(payload.gscQueries) ? payload.gscQueries : [];

    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }

    // Enqueue the scan job
    const job = await createScanJob({ brand, url, industry, competitors, querySource, gscQueries });

    // Trigger background worker asynchronously (non-blocking)
    startScanJob(job.id, brand, url, industry, competitors, querySource, gscQueries).catch(err => {
      console.error(`[worker-trigger] Error in async background scan job ${job.id}:`, err);
    });

    return NextResponse.json({
      job_id: job.id,
      status: job.status,
      progress_pct: job.progress_pct
    }, { status: 201 });
  } catch (error) {
    console.error("Scan API POST handler error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
