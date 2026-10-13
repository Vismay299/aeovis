import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createContentJob, hasActiveContentJobForBrand } from "@/lib/db/content";
import { startContentJob } from "@/lib/content/contentWorker";
import { keepAlive } from "@/lib/keepAlive";
import { PLAYBOOKS } from "@/lib/content/schemas";
import { starterAgentsForWorkspace } from "@/lib/content/agents/model";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const json = (value, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  const [items, jobs] = await Promise.all([
    ctx.client.from("content_items").select("id,title,status,playbook,agent_snapshot,created_at,updated_at").eq("brand", ctx.brand.brandKey).order("updated_at", { ascending: false }).limit(30),
    ctx.client.from("content_jobs").select("id,playbook,status,progress_pct,item_id,error_message,input,agent_snapshot,agent_trace,created_at").eq("brand", ctx.brand.brandKey).order("created_at", { ascending: false }).limit(10),
  ]);
  if (items.error || jobs.error) return json({ error: "Could not load Content Studio." }, 503);
  // The composer's brief is the customer's own text and is not needed for progress.
  const labelAgent = ({ agent_snapshot, ...row }) => ({ ...row,
    agent_name: typeof agent_snapshot?.name === "string" ? agent_snapshot.name : null,
    agent_format: typeof agent_snapshot?.format === "string" ? agent_snapshot.format : null,
  });
  const jobRows = (jobs.data || []).map((job) => ({ ...labelAgent(job), input: { query: typeof job.input?.query === "string" ? job.input.query : "" } }));
  return json({ items: (items.data || []).map(labelAgent), jobs: jobRows });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const ctx = await customerRouteContext(request, body.brand_key);
  if (ctx.response) return ctx.response;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  let playbook = body.playbook || "geo_article";
  let agent = null;
  if (body.agent_id) {
    const result = await ctx.client.from("content_agents").select("*").eq("id", body.agent_id).eq("brand", ctx.brand.brandKey).maybeSingle();
    if (result.error) return json({ error: "Could not load the selected agent." }, 503);
    if (!result.data || result.data.active === false) return json({ error: "Agent not found or inactive." }, 404);
    agent = result.data;
    playbook = agent.base;
  } else if (body.template_slug) {
    agent = starterAgentsForWorkspace(ctx.brand.brandKey).find((template) => template.slug === body.template_slug);
    if (!agent) return json({ error: "Starter agent not found." }, 400);
    playbook = agent.base;
  }
  if (!query || query.length > 300 || brief.length > 8000 || !PLAYBOOKS.includes(playbook)) return json({ error: "Provide a topic up to 300 characters and a valid format." }, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Content generation is not configured." }, 503);
  try {
    if (await hasActiveContentJobForBrand(ctx.brand.brandKey, { playbook, query }, { client: admin })) return json({ error: "This topic is already being generated." }, 409);
    const job = await createContentJob({ brand: ctx.brand.brandKey, playbook, agent_id: agent?.id, agent_snapshot: agent, input: {
      query, brief, brand_name: ctx.brand.display_name, url: ctx.brand.website,
    } }, { client: admin });
    keepAlive(() => startContentJob(job.id), { label: "customer-content" });
    return json({ job_id: job.id, status: job.status }, 201);
  } catch { return json({ error: "Could not start content generation." }, 503); }
}
