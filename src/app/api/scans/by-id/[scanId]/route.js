import { NextResponse } from "next/server";
import { getScanById, enrichScanForClient, isValidScanId } from "../../_lib/scanRow";

// P0.3: fetch ONE scan by its DB row id, raw_results included. Backs
// /dashboard/[brand]/[scanId] and the runScan() result_id completion path in
// src/shared/api.js. Must always be fresh — a scan that just completed has
// to be readable on the very next request.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const NO_STORE_HEADERS = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET(request, { params }) {
  params = await params;
  try {
    const { scanId } = params || {};
    if (!scanId || !isValidScanId(scanId)) {
      return NextResponse.json(
        { detail: "A valid scan id is required." },
        { status: 400 }
      );
    }

    let scan;
    try {
      scan = await getScanById(scanId);
    } catch (dbError) {
      console.error(`Error fetching scan ${scanId}:`, dbError);
      return NextResponse.json(
        { detail: "Internal Server Error" },
        { status: 500 }
      );
    }

    if (!scan) {
      return NextResponse.json({ detail: "Scan not found." }, { status: 404 });
    }

    if (scan.brand_key) {
      const { getCustomerContext } = await import("@/shared/supabase/customer");
      const context = await getCustomerContext();
      if (context.error || !context.brands.some((brand) => brand.brandKey === scan.brand_key)) {
        return NextResponse.json({ detail: "Scan not found." }, { status: 404 });
      }
    }
    return NextResponse.json(
      { scan: enrichScanForClient(scan) },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("Error in GET /api/scans/by-id/[scanId]:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
