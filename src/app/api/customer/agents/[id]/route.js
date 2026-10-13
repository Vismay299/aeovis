import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { normalizeAgent } from "@/lib/content/agents/model";

export const dynamic = "force-dynamic";
const json = (value, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function mutate(request, params, remove) {
  const { id } = await params;
  const body = remove ? {} : await request.json().catch(() => ({}));
  const ctx = await customerRouteContext(request, body.brand_key);
  if (ctx.response) return ctx.response;
  const { data: existing, error } = await ctx.client.from("content_agents").select("*").eq("id", id).eq("brand", ctx.brand.brandKey).maybeSingle();
  if (error) return json({ error: "Could not load agent." }, 503);
  if (!existing) return json({ error: "Agent not found." }, 404);
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Agent storage is not configured." }, 503);
  if (remove) {
    const result = await admin.from("content_agents").delete().eq("id", id).eq("brand", ctx.brand.brandKey);
    return result.error ? json({ error: "Could not delete agent." }, 503) : json({ deleted: true });
  }
  const result = normalizeAgent({ ...existing, ...body }, ctx.brand.brandKey);
  if (!result.ok) return json({ error: result.errors.join("; ") }, 400);
  const saved = await admin.from("content_agents").update({ ...result.agent, is_builtin: existing.is_builtin === true, updated_at: new Date().toISOString() }).eq("id", id).eq("brand", ctx.brand.brandKey).select().single();
  return saved.error ? json({ error: "Could not save agent." }, 503) : json({ agent: saved.data });
}
export async function PUT(request, { params }) { return mutate(request, params, false); }
export async function DELETE(request, { params }) { return mutate(request, params, true); }
