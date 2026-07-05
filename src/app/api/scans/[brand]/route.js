import { NextResponse } from "next/server";
import { getScansForBrand } from "@/lib/db";

export async function GET(request, { params }) {
  try {
    const { brand } = params;
    if (!brand) {
      return NextResponse.json({ detail: "Brand is required." }, { status: 400 });
    }

    const scans = await getScansForBrand(brand);
    // Normalize a bit for client: expose used_dynamic + competitor count from raw if present
    const normalized = (scans || []).map(s => {
      const raw = s.raw_results || {};
      const used = s.used_dynamic_prompts ?? (raw && (raw.used_dynamic_prompts ?? raw.usedDynamicPrompts));
      // Attach flat results for potential richer history use (Phase 2+)
      const attachedResults = raw.results || s.results || [];
      return {
        ...s,
        used_dynamic_prompts: !!used,
        competitor_count: Array.isArray(raw?.competitors) ? raw.competitors.length : (s.competitors?.length || 0),
        results: attachedResults,
      };
    });
    return NextResponse.json({ scans: normalized });
  } catch (error) {
    console.error("Error fetching scan history:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
