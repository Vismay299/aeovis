import { NextResponse } from "next/server";
import { getScanJob } from "@/lib/db";
import { runScanChunk, shouldRescueJob } from "@/lib/workers/scanWorker";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request, { params }) {
  try {
    const { job_id } = params;
    if (!job_id) {
      return NextResponse.json({ detail: "Job ID is required." }, { status: 400 });
    }

    let job;
    try {
      job = await getScanJob(job_id);
    } catch (error) {
      // Transient DB read failure. The client (services/api.js) tolerates up
      // to 5 CONSECUTIVE poll errors before giving up on an otherwise-healthy
      // multi-minute scan, but a hard 500 here would burn one of those for
      // what's often a one-tick blip. Answering 200 instead keeps the poll
      // loop alive for the next tick (2s later) to retry the read; if the DB
      // is genuinely down, every subsequent tick fails this same read and the
      // client's own timeout still bounds how long a user waits. Chosen
      // deliberately over a 503 — documented here per P0.2's "your call" note.
      //
      // R2.8.3 (finding A11): this used to answer `status: "working"`, which
      // claimed a reading it did not have. The client mapped it to stage 0 and
      // rendered `progress_pct: null` as "% complete", rewinding a half-done
      // scan to an empty bar. The status is now "unknown" and says so in three
      // ways the client can act on — status, transient_error, progress_known —
      // and progress_pct stays null (never 0), because we did not measure it.
      console.error(`Transient error reading job ${job_id}:`, error);
      return NextResponse.json(
        {
          status: "unknown",
          progress_pct: null,
          progress_known: false,
          transient_error: true,
          detail: "Job status is temporarily unreadable. Retry on the next poll.",
        },
        { status: 200, headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
      );
    }

    if (!job) {
      return NextResponse.json({ detail: "Job not found." }, { status: 404 });
    }

    // Poll-driven rescue (P0.2): this route is already polled every ~2s by
    // the client, so piggyback the staleness check here instead of relying
    // solely on the cron sweep — a frozen/dropped chunk resumes within one
    // poll tick instead of waiting for the next cron interval. Fire-and-forget:
    // the status response must not wait on the rescued chunk to finish.
    if (shouldRescueJob(job)) {
      runScanChunk(job.id).catch((err) => {
        console.error(`[status-rescue] Failed to resume job ${job.id}:`, err);
      });
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
        run_record: job.run_record,
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
