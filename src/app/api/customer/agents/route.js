import { NextResponse } from "next/server";
import { customerRouteContext } from "@/shared/supabase/customerRoute";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { insertAgent } from "@/server/db/content";
import { normalizeAgent, starterAgentsForWorkspace } from "@/shared/content/agents/model";
import { FORMATS } from "@/shared/content/agents/formats";
import { CREW } from "@/shared/content/agents/crew";
import { BLOCKS, DEFAULT_PIPELINES } from "@/shared/content/agents/blocks";

export const dynamic = "force-dynamic";
const json = (value, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  try {
    // Reads use the customer's RLS session. Creating an agent is explicit;
    // merely opening the builder must not seed privileged writes.
    const result = await ctx.client.from("content_agents").select("*").eq("brand", ctx.brand.brandKey).order("created_at", { ascending: true });
    if (result.error) throw result.error;
    const agents = result.data || [];
    return json({ agents, templates: starterAgentsForWorkspace(ctx.brand.brandKey, agents), formats: Object.values(FORMATS), blocks: Object.values(BLOCKS), crew: CREW, default_pipelines: DEFAULT_PIPELINES });
  } catch { return json({ error: "Could not load agents." }, 503); }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const ctx = await customerRouteContext(request, body.brand_key);
  if (ctx.response) return ctx.response;
  const result = normalizeAgent(body, ctx.brand.brandKey);
  if (!result.ok) return json({ error: result.errors.join("; ") }, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Agent storage is not configured." }, 503);
  try {
    const agent = await insertAgent(ctx.brand.brandKey, { ...result.agent, is_builtin: false }, { client: admin });
    return json({ agent }, 201);
  } catch { return json({ error: "Could not save the agent." }, 503); }
}
