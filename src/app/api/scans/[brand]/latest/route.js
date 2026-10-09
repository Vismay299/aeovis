import { NextResponse } from "next/server";
import { getScansForBrand } from "@/lib/db";
import { enrichScanForClient } from "../../_lib/scanRow";

// P0.3: the single most recent scan for a brand. Same `ilike` display-name
// lookup as src/app/api/scans/[brand]/route.js (reuses getScansForBrand,
// already ordered scanned_at desc — this just takes the head). Backs
// /dashboard/[brand]. Must always be fresh, same reasoning as the sibling
// history route: a scan that just finished has to show up immediately.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const NO_STORE_HEADERS = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET(request, { params }) {
  params = await params;
  try {
    const { brand } = params || {};
    if (!brand) {
      return NextResponse.json({ detail: "Brand is required." }, { status: 400 });
    }

    let scans;
    try {
      scans = await getScansForBrand(brand);
    } catch (dbError) {
      // R2.8.4: this guard is LIVE, not defensive. getScansForBrand throws
      // ScansUnavailableError when the read could not be performed; it used to
      // return [], which fell through to the `if (!latest)` 404 below and told
      // a brand with 38 scans it had never been scanned. A 404 from this route
      // now means one thing only: the DB answered, and there is nothing there.
      // Never echo the raw DB error — the client only needs the status.
      console.error(`Error fetching latest scan for "${brand}":`, dbError);
      return NextResponse.json(
        { detail: "Internal Server Error" },
        { status: 500 }
      );
    }

    const latest = (scans || [])[0];
    if (!latest) {
      return NextResponse.json(
        { detail: "No scans found for this brand." },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { scan: enrichScanForClient(latest) },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("Error in GET /api/scans/[brand]/latest:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
