import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getScanJob } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Fast status read for the client. Probe work runs in the background via
 * waitUntil so polls never block 30–60s (which caused "Failed to retrieve scan").
 */
export async function GET(request, { params }) {
  try {
    const { job_id } = params;
    if (!job_id) {
      return NextResponse.json({ detail: "Job ID is required." }, { status: 400 });
    }

    const job = await getScanJob(job_id);
    if (!job) {
      return NextResponse.json({ detail: "Job not found." }, { status: 404 });
    }

    const resumable = [
      "pending",
      "generating_prompts",
      "probing",
      "scoring",
    ].includes(job.status);

    // Kick work in the background — never block the JSON response.
    if (resumable) {
      const work = startScanJob(
        job.id,
        job.brand,
        job.url || "",
        job.industry || "",
        job.competitors || ""
      ).catch((err) => {
        console.error(`[status] Background resume failed for job ${job_id}:`, err);
      });
      try {
        waitUntil(work);
      } catch {
        // Local next dev may not support waitUntil
        void work;
      }
    }

    // Slim checkpoint for in-progress jobs (full AIO texts make huge payloads).
    let runRecord = job.run_record || null;
    if (runRecord?.checkpoint && job.status !== "complete") {
      const cp = runRecord.checkpoint;
      runRecord = {
        checkpoint: {
          partial_count: Array.isArray(cp.partial_results)
            ? cp.partial_results.length
            : 0,
          queries_count: Array.isArray(cp.queries) ? cp.queries.length : 0,
          cost: cp.cost || 0,
        },
      };
    }

    return NextResponse.json(
      {
        id: job.id,
        brand: job.brand,
        status: job.status,
        progress_pct: job.progress_pct,
        result_id: job.result_id,
        error_message: job.error_message,
        created_at: job.created_at,
        // Full record only when complete (needed by the client to render the dashboard)
        run_record: job.status === "complete" ? job.run_record : runRecord,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (error) {
    console.error("Error retrieving job status:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
