import { NextResponse } from "next/server";
import {
  createContentJob,
  hasActiveContentJobForBrand,
} from "@/lib/db/content";
import { startContentJob } from "@/lib/content/contentWorker";
import { PLAYBOOKS } from "@/lib/content/schemas";

export const dynamic = "force-dynamic";

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
