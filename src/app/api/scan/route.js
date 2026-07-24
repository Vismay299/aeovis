import { NextResponse } from "next/server";
import { createScanJob, hasActiveScanForBrand } from "@/lib/db";
import { runScanChunk } from "@/lib/workers/scanWorker";

// A chunk can run for up to ~150s (CHUNK_TIME_BUDGET_MS in scanWorker.js)
// plus finalize; give the fire-and-forget first chunk kicked off below room
// to make real progress before the platform would otherwise cut it off.
export const maxDuration = 300;

export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    const url = (payload.url || "").trim();
    const industry = (payload.industry || "").trim();
    const competitors = (payload.competitors || "").trim();
    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }

    if (await hasActiveScanForBrand(brand)) {
      return NextResponse.json(
        { detail: "A scan for this brand is already in progress. Please wait for it to finish." },
        { status: 409 }
      );
    }

    // Enqueue the scan job
    const job = await createScanJob({ brand, url, industry, competitors });

    // Trigger the first chunk asynchronously (non-blocking). runScanChunk
    // resumes/advances by job id alone — sourcing, probing, and finalize are
    // all driven off the job row + checkpoint, not these function args.
    runScanChunk(job.id).catch(err => {
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
