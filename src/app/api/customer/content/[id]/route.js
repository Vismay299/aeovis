import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { decideItemStatus, jobStatusForItemStatus } from "@/lib/content/stages";
export const dynamic = "force-dynamic";
const json = (value, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function itemContext(request, id) {
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx;
  const { data, error } = await ctx.client.from("content_items").select("*").eq("id", id).eq("brand", ctx.brand.brandKey).maybeSingle();
  if (error) return { response: json({ error: "Could not load draft." }, 503) };
  if (!data) return { response: json({ error: "Draft not found." }, 404) };
  return { ...ctx, item: data };
}
export async function GET(request, { params }) {
  params = await params;
  const ctx = await itemContext(request, params.id);
  if (ctx.response) return ctx.response;
  if (new URL(request.url).searchParams.get("export") === "markdown") return new Response(`# ${ctx.item.title || "Draft"}\n\n${ctx.item.body_md || ""}`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="draft.md"', "Cache-Control": "no-store" },
  });
  return json({ item: ctx.item });
}
export async function PATCH(request, { params }) {
  params = await params;
  const ctx = await itemContext(request, params.id);
  if (ctx.response) return ctx.response;
  const body = await request.json().catch(() => ({}));
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 300 || typeof body.body_md !== "string" || body.body_md.length > 200000) return json({ error: "Provide a title and draft text." }, 400);
  if (!["draft", "awaiting_approval", "approved", "rejected"].includes(ctx.item.status)) return json({ error: "Wait for generation to finish before editing." }, 409);
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Draft editing is not configured." }, 503);
  if(body.content_version!==ctx.item.content_version)return json({error:"Draft changed; refresh before saving."},409);
  const { data, error } = await admin.from("content_items").update({ title: body.title.trim(), body_md: body.body_md, status: "awaiting_approval", updated_at: new Date().toISOString() })
    .eq("id", params.id).eq("brand", ctx.brand.brandKey).eq("status", ctx.item.status).eq("content_version",body.content_version).select("id").maybeSingle();
  if (error) return json({ error: "Could not save draft." }, 503);
  return data ? json({ saved: true }) : json({ error: "Draft changed. Refresh and retry." }, 409);
}
export async function POST(request, { params }) {
  params = await params;
  const ctx = await itemContext(request, params.id);
  if (ctx.response) return ctx.response;
  const body = await request.json().catch(() => ({}));
  if (!["approved", "rejected"].includes(body.verdict)) return json({ error: "Choose approved or rejected." }, 400);
  const decision = decideItemStatus(ctx.item.status, body.verdict);
  if (!decision.ok) return json({ error: decision.error }, 409);
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Draft review is not configured." }, 503);
  if(body.content_version!==ctx.item.content_version || body.content_hash!==ctx.item.content_hash)return json({error:"Draft changed; refresh before review."},409);
  const { error } = await admin.rpc("decide_checked_content", {
    p_item:params.id,p_brand:ctx.brand.brandKey,p_version:body.content_version,p_hash:body.content_hash,p_status:decision.status,
    p_actor:ctx.user.id,p_comment:typeof body.comment==="string"?body.comment.slice(0,4000):"",
  });
  return error ? json({ error: "Could not save review. Refresh and retry." }, 409) : json({ status: decision.status, published: false });
}
