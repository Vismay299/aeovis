import { NextResponse } from "next/server";
import { updateKnowledgeBlock, deleteKnowledgeBlock } from "@/lib/db/knowledge";

export const dynamic = "force-dynamic";

/** PUT /api/knowledge/[id] — update title/content/active. */
export async function PUT(request, { params }) {
  try {
    const payload = await request.json();
    const updates = {};
    if (typeof payload.title === "string") updates.title = payload.title.trim().slice(0, 120);
    if (typeof payload.content === "string") updates.content = payload.content;
    if (typeof payload.active === "boolean") updates.active = payload.active;
    const block = await updateKnowledgeBlock(params.id, updates);
    if (!block) return NextResponse.json({ detail: "Block not found." }, { status: 404 });
    return NextResponse.json({ block });
  } catch (error) {
    console.error("Knowledge PUT error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/** DELETE /api/knowledge/[id] */
export async function DELETE(request, { params }) {
  try {
    const ok = await deleteKnowledgeBlock(params.id);
    return NextResponse.json({ deleted: ok });
  } catch (error) {
    console.error("Knowledge DELETE error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
