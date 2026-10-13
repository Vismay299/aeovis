import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { runMockScan } from "@/lib/demo/mockScan";

export const dynamic = "force-dynamic";
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const ctx = await customerRouteContext(request, body.brand_key);
  if (ctx.response) return ctx.response;
  try {
    const result = await runMockScan({ brand: ctx.brand.display_name, url: ctx.brand.website });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Mock scan could not finish. Please try again." }, { status: 500 });
  }
}
