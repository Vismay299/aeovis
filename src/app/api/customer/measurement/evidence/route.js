import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
const fail = (message, status) =>
  new Response(message, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request) {
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  const admin = getSupabaseAdmin();
  if (!admin) return fail("Evidence storage unavailable", 503);
  const params = new URL(request.url).searchParams;
  const { data: observation, error } = await admin
    .from("probe_observations")
    .select("id,scan_jobs!inner(brand_key)")
    .eq("id", params.get("observation"))
    .eq("scan_jobs.brand_key", ctx.brand.brandKey)
    .maybeSingle();
  if (error) return fail("Could not read evidence ownership", 503);
  if (!observation) return fail("Evidence unavailable", 404);
  const { data: capture, error: readError } = await admin
    .from("measurement_evidence")
    .select("*")
    .eq("observation_id", observation.id)
    .eq("attempt_token", params.get("attempt"))
    .eq("capture_index", Number(params.get("index") || 0))
    .maybeSingle();
  if (readError) return fail("Could not read evidence", 503);
  if (!capture) return fail("Evidence unavailable", 404);
  if(capture.reason==="redaction_retracted")return fail("This capture was withdrawn because its redaction could not be verified. The measurement is retained.",410);
  if (capture.state !== "stored" && capture.state !== "expired")
    return fail("This capture was not stored. The observation has incomplete evidence.",409);
  const remaining = Date.parse(capture.expires_at) - Date.now();
  if (
    capture.state === "expired" ||
    !Number.isFinite(remaining) || remaining < 1000
  )
    return fail(
      "Raw capture expired under the retention policy. The measurement is retained.",
      410,
    );
  const { data, error: signError } = await admin.storage
    .from("probe-evidence")
    .createSignedUrl(capture.object_key, Math.min(120, Math.floor(remaining / 1000)));
  if (signError || !data?.signedUrl)
    return fail("Could not open the stored capture", 503);
  return new Response(null, {
    status: 302,
    headers: {
      Location: data.signedUrl,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
