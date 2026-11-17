import { NextResponse } from "next/server";
import { customerRouteContext } from "@/shared/supabase/customerRoute";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
export const dynamic = "force-dynamic";
const MAX_OBSERVATIONS = 800;
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
      // Metadata only: answer text stays in the report. The limit covers one
      // full 200-question panel on all four engines (the panel maximum).
      .select(
        "id,job_id,engine,query,state,attempt_count,reason,observed_at,provenance:result->provenance,attempt_id:result->>attempt_id,result_evidence_state:result->>evidence_state,scan_jobs!inner(brand_key)",
      )
      .eq("scan_jobs.brand_key", ctx.brand.brandKey)
      .order("created_at", { ascending: false })
      .limit(MAX_OBSERVATIONS),
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
  const ids=observations.data.map(o=>o.id);
  // Batched so hundreds of 64-character IDs never overflow one request URL.
  const batches=[];for(let i=0;i<ids.length;i+=100)batches.push(ids.slice(i,i+100));
  const reads=await Promise.all(batches.map(batch=>admin.from("measurement_evidence")
    .select("observation_id,attempt_token,capture_index,state,expires_at,reason")
    .in("observation_id",batch)));
  const evidence={data:reads.flatMap(r=>r.data || []),error:reads.find(r=>r.error)?.error || null};
  if(evidence.error)return NextResponse.json({error:"Could not load private evidence metadata"},{status:503});
  const captureView=o=>(evidence.data || []).filter(c=>c.observation_id===o.id && c.attempt_token===o.attempt_id)
    .map(c=>({index:c.capture_index,reason:c.reason||null,state:c.state==="stored" && (!Number.isFinite(Date.parse(c.expires_at)) || Date.parse(c.expires_at)<=Date.now()) ? "expired" : c.state}));
  return NextResponse.json(
    {
      observations: observations.data.map((o) => ({
        ...o,
        result_evidence_state: undefined,
        provenance: o.provenance || null,
        evidence_state: captureView(o).some(c=>c.reason==="redaction_retracted") ? "withdrawn" : captureView(o).some(c=>c.state==="expired") ? "expired" : captureView(o).some(c=>c.state!=="stored") ? "incomplete" : o.result_evidence_state || "legacy_unknown",
        attempt_id: o.attempt_id || null,
        captures: captureView(o),
      })),
      windows: windows.data,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
