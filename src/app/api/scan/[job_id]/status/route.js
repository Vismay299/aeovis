import { NextResponse } from "next/server";
import { getScanJob } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
