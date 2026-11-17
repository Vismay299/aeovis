import { NextResponse } from "next/server";
import { runMockScan } from "@/server/demo/mockScan";
export const dynamic = "force-dynamic";
export async function POST() {
  try { return NextResponse.json(await runMockScan(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { console.error("Mock scan failed", error); return NextResponse.json({ error: "Mock scan failed." }, { status: 500 }); }
}
