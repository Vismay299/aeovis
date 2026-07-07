import { NextResponse } from "next/server";
import { getContentEvents, insertContentEvent, getScansForBrand } from "@/lib/db";
import { computeContentLiftReports } from "@/lib/scoring/contentLift";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const brand = searchParams.get("brand");

    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }

    const events = await getContentEvents(brand);
    const scans = await getScansForBrand(brand);

    const persistedLift = scans[0]?.raw_results?.content_lift;
    if (Array.isArray(persistedLift) && persistedLift.length > 0) {
      const reports = events.map((event) => {
        const liftReport = persistedLift.find((r) => r.url === event.url) || {};
        return {
          ...event,
          related_prompts: liftReport.related_prompts || [],
          current_score: liftReport.current_score ?? null,
          previous_score: liftReport.previous_score ?? null,
          lift: liftReport.lift ?? null,
        };
      });
      return NextResponse.json(reports);
    }

    const latestResults = scans[0]?.raw_results?.results || [];
    const prevResults = scans[1]?.raw_results?.results || [];
    const reports = computeContentLiftReports(events, latestResults, prevResults);

    return NextResponse.json(reports);
  } catch (error) {
    console.error("Content events GET API error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    const url = (payload.url || "").trim();
    const publishDate = payload.publishDate || new Date().toISOString();

    if (!brand || !url) {
      return NextResponse.json({ detail: "Brand name and URL are required." }, { status: 400 });
    }

    const newEvent = await insertContentEvent({ brand, url, publishDate });
    return NextResponse.json(newEvent, { status: 201 });
  } catch (error) {
    console.error("Content events POST API error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
