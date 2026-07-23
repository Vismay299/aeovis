import { NextResponse } from "next/server";
import { listLessons, setLessonActive } from "@/lib/db/content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/lessons?brand=&playbook=&all=1 — the lessons panel. */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const brand = (searchParams.get("brand") || "").trim();
    const playbook = (searchParams.get("playbook") || "").trim() || undefined;
    const includeInactive = searchParams.get("all") === "1";

    if (!brand) {
      return NextResponse.json({ detail: "brand query param is required." }, { status: 400 });
    }

    const lessons = await listLessons(brand, playbook, { activeOnly: !includeInactive });
    return NextResponse.json(
      { lessons },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Lessons GET error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/** PATCH /api/lessons — { id, active } toggle. */
export async function PATCH(request) {
  try {
    const payload = await request.json();
    const id = (payload.id || "").trim();
    if (!id || typeof payload.active !== "boolean") {
      return NextResponse.json(
        { detail: "id (string) and active (boolean) are required." },
        { status: 400 }
      );
    }

    const updated = await setLessonActive(id, payload.active);
    if (!updated) {
      return NextResponse.json({ detail: "Lesson not found." }, { status: 404 });
    }
    return NextResponse.json({ lesson: updated });
  } catch (error) {
    console.error("Lessons PATCH error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
