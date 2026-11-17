import { NextResponse } from "next/server";
import { getBrandBrief, upsertBrandBrief } from "@/server/db/content";
import { HEALTHCARE_CXO_BRIEF } from "@/shared/content/briefs/healthcareCxo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/brand-briefs?brand= — stored brief, or the healthcare-cxo
 * template (marked `seeded: true`) when none exists yet. */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const brand = (searchParams.get("brand") || "").trim();
    if (!brand) {
      return NextResponse.json({ detail: "brand query param is required." }, { status: 400 });
    }

    const stored = await getBrandBrief(brand);
    if (stored?.brief) {
      return NextResponse.json(
        { brand, brief: stored.brief, seeded: false, updated_at: stored.updated_at },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { brand, brief: HEALTHCARE_CXO_BRIEF, seeded: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Brand brief GET error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/** PUT /api/brand-briefs — { brand, brief } upsert from the Studio editor. */
export async function PUT(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    const brief = payload.brief;

    if (!brand) {
      return NextResponse.json({ detail: "brand is required." }, { status: 400 });
    }
    if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
      return NextResponse.json({ detail: "brief must be an object." }, { status: 400 });
    }

    const saved = await upsertBrandBrief(brand, brief);
    return NextResponse.json({ brand, brief: saved.brief, updated_at: saved.updated_at });
  } catch (error) {
    console.error("Brand brief PUT error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
