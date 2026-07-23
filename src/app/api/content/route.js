import { NextResponse } from "next/server";
import {
  createContentJob,
  hasActiveContentJobForBrand,
  listContentJobs,
} from "@/lib/db/content";
import { startContentJob } from "@/lib/content/contentWorker";
import { PLAYBOOKS } from "@/lib/content/schemas";

export const dynamic = "force-dynamic";

/** GET /api/content?brand= — recent jobs (Studio's in-flight cards). */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const brand = (searchParams.get("brand") || "").trim();
    const jobs = await listContentJobs(brand || undefined, 20);
    const slim = jobs.map((j) => ({
      id: j.id,
      brand: j.brand,
      playbook: j.playbook,
      status: j.status,
      progress_pct: j.progress_pct,
      item_id: j.item_id,
      error_message: j.error_message,
      cost_total: j.cost_total,
      created_at: j.created_at,
    }));
    return NextResponse.json(
      { jobs: slim },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (error) {
    console.error("Content jobs list error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * POST /api/content — create a content job { brand, playbook, input }.
 * Mirrors POST /api/scan: 409 duplicate guard, fire-and-forget worker.
 */
export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    const playbook = (payload.playbook || "").trim();
    const input = payload.input && typeof payload.input === "object" ? payload.input : {};

    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }
    if (!PLAYBOOKS.includes(playbook)) {
      return NextResponse.json(
        { detail: `playbook must be one of: ${PLAYBOOKS.join(", ")}` },
        { status: 400 }
      );
    }

    if (await hasActiveContentJobForBrand(brand, playbook)) {
      return NextResponse.json(
        { detail: "A content job for this brand and playbook is already in progress." },
        { status: 409 }
      );
    }

    const job = await createContentJob({ brand, playbook, input });

    startContentJob(job.id).catch((err) => {
      console.error(`[content-trigger] Error in background content job ${job.id}:`, err);
    });

    return NextResponse.json(
      { job_id: job.id, status: job.status, progress_pct: job.progress_pct },
      { status: 201 }
    );
  } catch (error) {
    console.error("Content API POST handler error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
