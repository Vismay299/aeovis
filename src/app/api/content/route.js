import { NextResponse } from "next/server";
import {
  createContentJob,
  hasActiveContentJobForBrand,
  listContentJobs,
  getAgent,
} from "@/lib/db/content";
import { startContentJob } from "@/lib/content/contentWorker";
import { keepAlive } from "@/lib/keepAlive";
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
      agent_snapshot: j.agent_snapshot || null,
      agent_trace: j.agent_trace || [],
      input: j.input || {},
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
    const input = payload.input && typeof payload.input === "object" ? payload.input : {};
    const agentId = (payload.agent_id || "").trim();

    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }

    // An agent, if given, determines the base playbook. Otherwise the caller
    // may pass a raw playbook (back-compat with the v1 trigger).
    let agent = null;
    if (agentId) {
      agent = await getAgent(agentId);
      if (!agent) {
        return NextResponse.json({ detail: "Agent not found." }, { status: 404 });
      }
    }
    const playbook = agent ? agent.base : (payload.playbook || "").trim();

    if (!PLAYBOOKS.includes(playbook)) {
      return NextResponse.json(
        { detail: `playbook (or agent base) must be one of: ${PLAYBOOKS.join(", ")}` },
        { status: 400 }
      );
    }

    // Duplicate guard: concurrency across different agents is allowed; only an
    // exact re-fire (same agent + same target query) is blocked.
    if (
      await hasActiveContentJobForBrand(brand, {
        playbook,
        agentId: agent?.id || null,
        query: input?.query || "",
      })
    ) {
      return NextResponse.json(
        { detail: "This agent is already generating content for this query." },
        { status: 409 }
      );
    }

    const job = await createContentJob({
      brand,
      playbook,
      input,
      agent_id: agent?.id || null,
      agent_snapshot: agent || null,
    });

    keepAlive(() => startContentJob(job.id), { label: `[content-trigger] content job ${job.id}` });

    return NextResponse.json(
      { job_id: job.id, status: job.status, progress_pct: job.progress_pct, agent: agent?.name || null },
      { status: 201 }
    );
  } catch (error) {
    console.error("Content API POST handler error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
