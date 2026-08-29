import { NextResponse } from "next/server";
import { createScanJob, hasActiveScanForBrand } from "@/lib/db";
import { DuplicateScanError } from "@/lib/duplicateScan";
import { checkScanRateLimit } from "@/lib/rateLimit";
import { incrementScanRateLimit } from "@/lib/db/analytics";
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

    // R0.1.4: the free scan is anonymous and spends real Bright Data +
    // Perplexity + LLM budget per call. Counted BEFORE the duplicate check so
    // a caller cannot probe for free by hammering an already-scanning brand.
    const rate = await checkScanRateLimit({
      header: (name) => request.headers.get(name),
      increment: (args) => incrementScanRateLimit(args),
    });
    if (!rate.allowed) {
      return NextResponse.json(
        {
          detail: `Too many scans from this address. Try again in ${Math.ceil(
            rate.retryAfterSec / 60
          )} minute(s).`,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rate.retryAfterSec),
            "X-RateLimit-Limit": String(rate.limit),
            "X-RateLimit-Remaining": String(rate.remaining),
          },
        }
      );
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
    // R0.1.5: the database (migration 007's unique partial index) is now the
    // authority on "one running scan per brand". The pre-flight
    // hasActiveScanForBrand check above is a courtesy that fails open; this is
    // the one that actually holds, and it must surface as 409, not 500.
    if (error instanceof DuplicateScanError || error?.name === "DuplicateScanError") {
      return NextResponse.json(
        { detail: "A scan for this brand is already in progress. Please wait for it to finish." },
        { status: 409 }
      );
    }
    console.error("Scan API POST handler error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
