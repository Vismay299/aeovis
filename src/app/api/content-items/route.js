import { NextResponse } from "next/server";
import { listContentItems } from "@/server/db/content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/content-items?brand= — list items + statuses for Studio. */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const brand = (searchParams.get("brand") || "").trim();

    const items = await listContentItems(brand || undefined);

    // The queue list doesn't need full bodies/packs — trim the payload.
    const slim = items.map((i) => ({
      id: i.id,
      job_id: i.job_id,
      brand: i.brand,
      playbook: i.playbook,
      agent_snapshot: i.agent_snapshot || null,
      title: i.title,
      status: i.status,
      revision: i.revision,
      rubric_verdict: i.rubric?.verdict || null,
      rubric_total: i.rubric?.weighted_total ?? null,
      below_threshold: i.rubric?.below_threshold === true,
      ymyl_violation: i.rubric?.ymyl_violation === true,
      target_queries: i.target_queries || [],
      created_at: i.created_at,
      updated_at: i.updated_at,
    }));

    return NextResponse.json(
      { items: slim },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (error) {
    console.error("Content items list error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
