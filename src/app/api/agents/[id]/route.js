import { NextResponse } from "next/server";
import { getAgent, updateAgent, deleteAgent } from "@/server/db/content";
import { normalizeAgent } from "@/shared/content/agents/model";

export const dynamic = "force-dynamic";

/** GET /api/agents/[id] — one agent. */
export async function GET(request, { params }) {
  params = await params;
  try {
    const agent = await getAgent(params.id);
    if (!agent) return NextResponse.json({ detail: "Agent not found." }, { status: 404 });
    return NextResponse.json({ agent }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Agent GET error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/** PUT /api/agents/[id] — update an agent's config. */
export async function PUT(request, { params }) {
  params = await params;
  try {
    const existing = await getAgent(params.id);
    if (!existing) return NextResponse.json({ detail: "Agent not found." }, { status: 404 });

    const payload = await request.json();
    const { ok, errors, agent } = normalizeAgent(
      { ...existing, ...payload },
      existing.brand
    );
    if (!ok) return NextResponse.json({ detail: errors.join("; ") }, { status: 400 });

    // Preserve built-in status; users edit built-ins in place but can't forge one.
    agent.is_builtin = existing.is_builtin === true;
    const saved = await updateAgent(params.id, agent);
    return NextResponse.json({ agent: saved });
  } catch (error) {
    console.error("Agent PUT error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/** DELETE /api/agents/[id] — remove a custom agent. */
export async function DELETE(request, { params }) {
  params = await params;
  try {
    const existing = await getAgent(params.id);
    if (!existing) return NextResponse.json({ detail: "Agent not found." }, { status: 404 });
    const ok = await deleteAgent(params.id);
    return NextResponse.json({ deleted: ok });
  } catch (error) {
    console.error("Agent DELETE error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
