import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { readProviderReadiness } from "@/server/db/probeDispatch";
export const dynamic = "force-dynamic";
export async function GET() {
  const client = getSupabaseAdmin();
  if (!client)
    return NextResponse.json(
      { error: "Measurement storage unavailable" },
      { status: 503 },
    );
  const [readiness, incidents, attempts, windows] = await Promise.all([
    readProviderReadiness(),
    client
      .from("measurement_incidents")
      .select("*")
      .order("last_seen", { ascending: false })
      .limit(100),
    client
      .from("probe_observations")
      .select(
        "id,job_id,engine,state,attempt_count,reason,unknown_cost_calls,total_cost,next_attempt_at",
      )
      .in("state", ["retry", "ambiguous", "blocked", "failed"])
      .order("created_at", { ascending: false })
      .limit(100),
    client
      .from("measurement_windows")
      .select("*")
      .order("window_at", { ascending: false })
      .limit(100),
  ]);
  if ([incidents, attempts, windows].some((r) => r.error))
    return NextResponse.json(
      { error: "Could not load measurement operations" },
      { status: 503 },
    );
  return NextResponse.json(
    {
      readiness,
      incidents: incidents.data,
      observations: attempts.data,
      windows: windows.data,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const client = getSupabaseAdmin();
  if (!client)
    return NextResponse.json(
      { error: "Measurement storage unavailable" },
      { status: 503 },
    );
  if (!body.incident_id || body.action !== "acknowledge")
    return NextResponse.json(
      { error: "Choose an incident to acknowledge" },
      { status: 400 },
    );
  const { error } = await client
    .from("measurement_incidents")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", body.incident_id);
  return NextResponse.json(
    error
      ? { error: "Could not acknowledge incident" }
      : { acknowledged: true },
    { status: error ? 503 : 200 },
  );
}
