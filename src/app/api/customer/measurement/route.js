import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export async function GET(request) {
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  const admin = getSupabaseAdmin();
  if (!admin)
    return NextResponse.json(
      { error: "Measurement storage unavailable" },
      { status: 503 },
    );
  const [observations, windows] = await Promise.all([
    admin
      .from("probe_observations")
      .select(
        "id,engine,state,attempt_count,reason,observed_at,result,scan_jobs!inner(brand_key)",
      )
      .eq("scan_jobs.brand_key", ctx.brand.brandKey)
      .order("created_at", { ascending: false })
      .limit(100),
    admin
      .from("measurement_windows")
      .select("window_at,disposition,reason,finalized_at,outcome")
      .eq("brand", ctx.brand.brandKey)
      .order("window_at", { ascending: false })
      .limit(30),
  ]);
  if (observations.error || windows.error)
    return NextResponse.json(
      { error: "Could not load measurement history" },
      { status: 503 },
    );
  return NextResponse.json(
    {
      observations: observations.data.map((o) => ({
        ...o,
        result: undefined,
        provenance: o.result?.provenance || null,
        evidence_state: o.result?.evidence_state || "legacy_unknown",
        attempt_id: o.result?.attempt_id || null,
        captures: (o.result?.evidence_captures || []).map((c, index) => ({
          index,
          state: c.state,
        })),
      })),
      windows: windows.data,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
