import { NextResponse } from "next/server";
import { getContentItem } from "@/server/db/content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/content-items/[id] — full item for the Studio item view. */
export async function GET(request, { params }) {
  params = await params;
  try {
    const { id } = params;
    if (!id) {
      return NextResponse.json({ detail: "Item ID is required." }, { status: 400 });
    }

    const item = await getContentItem(id);
    if (!item) {
      return NextResponse.json({ detail: "Item not found." }, { status: 404 });
    }

    return NextResponse.json(
      { item },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
    );
  } catch (error) {
    console.error("Content item fetch error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
