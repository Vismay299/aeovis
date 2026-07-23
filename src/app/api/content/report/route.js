import { NextResponse } from "next/server";
import { generateWeeklyReport } from "@/lib/content/weeklyReport";

export const dynamic = "force-dynamic";

/** POST /api/content/report — { brand } → weekly report (one LLM call). */
export async function POST(request) {
  try {
    const { brand } = await request.json();
    if (!brand || !brand.trim()) {
      return NextResponse.json({ detail: "brand is required." }, { status: 400 });
    }

    const report = await generateWeeklyReport(brand.trim(), {
      now: new Date().toISOString(),
    });
    if (report.error) {
      return NextResponse.json({ detail: report.error }, { status: 400 });
    }

    return NextResponse.json({ report });
  } catch (error) {
    console.error("Weekly report error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
