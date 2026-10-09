import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createContentJob, hasActiveContentJobForBrand } from "@/lib/db/content";
import { startContentJob } from "@/lib/content/contentWorker";
import { keepAlive } from "@/lib/keepAlive";
import { PLAYBOOKS } from "@/lib/content/schemas";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const json = (value, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  const [items, jobs] = await Promise.all([
    ctx.client.from("content_items").select("id,title,status,updated_at").eq("brand", ctx.brand.brandKey).order("updated_at", { ascending: false }).limit(30),
    ctx.client.from("content_jobs").select("id,status,progress_pct,item_id,error_message,created_at").eq("brand", ctx.brand.brandKey).order("created_at", { ascending: false }).limit(10),
  ]);
  if (items.error || jobs.error) return json({ error: "Could not load Content Studio." }, 503);
  return json({ items: items.data || [], jobs: jobs.data || [] });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const ctx = await customerRouteContext(request, body.brand_key);
  if (ctx.response) return ctx.response;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  const playbook = body.playbook || "geo_article";
  if (!query || query.length > 300 || brief.length > 8000 || !PLAYBOOKS.includes(playbook)) return json({ error: "Provide a topic up to 300 characters and a valid format." }, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Content generation is not configured." }, 503);
  try {
    if (await hasActiveContentJobForBrand(ctx.brand.brandKey, { playbook, query }, { client: admin })) return json({ error: "This topic is already being generated." }, 409);
    const job = await createContentJob({ brand: ctx.brand.brandKey, playbook, input: {
      query, brief, brand_name: ctx.brand.display_name, url: ctx.brand.website,
    } }, { client: admin });
    keepAlive(() => startContentJob(job.id), { label: "customer-content" });
    return json({ job_id: job.id, status: job.status }, 201);
  } catch { return json({ error: "Could not start content generation." }, 503); }
}
