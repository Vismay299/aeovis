import { NextResponse } from "next/server";
import { getContentEvents, insertContentEvent, getScansForBrand } from "@/server/db";
import { computeContentLiftReports } from "@/shared/scoring/contentLift";

/**
 * R5.2.1 / finding B13 — the decision route used to synthesize
 * `https://studio.perceev.app/content/<slug>` on approval and store it here as
 * if a page had been published. That synthesis is deleted, but rows written
 * before the deletion can still sit in `content_events`, and every lift number
 * computed from one of them is attribution to a page that does not exist.
 *
 * This reader will not serve such a number. A row on the fabricated host comes
 * back with its lift fields null and an explicit reason, so "we never measured
 * this because the URL was invented" cannot be read as "measured, no change".
 */
export const FABRICATED_EVENT_HOST = "studio.perceev.app";

/** True when `url` is on the host the old approval path invented. */
export function isFabricatedEventUrl(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase() === FABRICATED_EVENT_HOST;
  } catch {
    return false;
  }
}

/**
 * Strip the lift figures off a fabricated-URL row and say why. Exported so a
 * test can drive it without a database.
 */
export function withFabricatedUrlsQuarantined(reports) {
  return (reports || []).map((report) => {
    if (!isFabricatedEventUrl(report?.url)) return report;
    return {
      ...report,
      related_prompts: [],
      current_score: null,
      previous_score: null,
      lift: null,
      fabricated_url: true,
      lift_unavailable_reason: "fabricated_url",
      detail:
        `This row's URL was synthesized on approval by a code path that has been ` +
        `deleted (finding B13). Nothing was ever published at ${FABRICATED_EVENT_HOST}, ` +
        `so no lift can be attributed to it — this is not a measured zero.`,
    };
  });
}

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
      return NextResponse.json(withFabricatedUrlsQuarantined(reports));
    }

    const latestResults = scans[0]?.raw_results?.results || [];
    const prevResults = scans[1]?.raw_results?.results || [];
    const reports = computeContentLiftReports(events, latestResults, prevResults);

    return NextResponse.json(withFabricatedUrlsQuarantined(reports));
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
    // The fabricated host can no longer be written by approval (R5.2.1); it
    // must not come back through the manual door either.
    if (isFabricatedEventUrl(url)) {
      return NextResponse.json(
        {
          detail:
            `${FABRICATED_EVENT_HOST} is not a real publication target — it was a synthesized ` +
            `host (finding B13). Register the URL the content was actually published at.`,
        },
        { status: 400 }
      );
    }

    const newEvent = await insertContentEvent({ brand, url, publishDate });
    return NextResponse.json(newEvent, { status: 201 });
  } catch (error) {
    console.error("Content events POST API error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
