import { NextResponse } from "next/server";
import { updatePromptStatus } from "@/lib/db/prompts";

export async function PATCH(request, { params }) {
  params = await params;
  try {
    const { id } = params;
    const { enabled } = await request.json();

    if (typeof enabled === "boolean") {
      const success = await updatePromptStatus(id, enabled);
      if (!success) {
        return NextResponse.json({ error: "Prompt not found or update failed" }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Failed to update prompt:", error);
    return NextResponse.json({ error: "Failed to update prompt" }, { status: 500 });
  }
}
