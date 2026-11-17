import { NextResponse } from "next/server";
import { customerRouteContext } from "@/shared/supabase/customerRoute";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { repairWorkflowStore } from "@/server/db/repairWorkflow";
import { verifyPublishUrl } from "@/shared/content/publishVerification";
export const dynamic = "force-dynamic";
const json = (value, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
export async function POST(request, { params }) {
  const { id } = await params;
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  const body = await request.json().catch(() => ({}));
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Publication unavailable" }, 503);
  const { data: item, error } = await ctx.client
    .from("content_items")
    .select("*")
    .eq("brand", ctx.brand.brandKey)
    .eq("id", id)
    .maybeSingle();
  if (error) return json({ error: "Could not load draft" }, 503);
  if (!item) return json({ error: "Draft not found" }, 404);
  if (
    body.content_version !== item.content_version ||
    body.content_hash !== item.content_hash
  )
    return json({ error: "Draft changed; refresh before publication" }, 409);
  if (item.status !== "approved" && item.status !== "published")
    return json({ error: "Approve the checked draft before publication" }, 409);
  let domains;
  try {
    domains = [new URL(ctx.brand.website).hostname];
  } catch {
    return json({ error: "Set a valid owned website before publication" }, 409);
  }
  const verification = await verifyPublishUrl({
    url: body.url,
    itemTitle: item.title,
    itemBody: item.body_md,
    allowedDomains: domains,
  });
  if (!verification.ok)
    return json(
      {
        error:
          verification.detail ||
          "Live content does not match the approved draft",
        verification,
      },
      422,
    );
  try {
    const publication = await repairWorkflowStore(admin).publish({
      p_item: id,
      p_brand: ctx.brand.brandKey,
      p_version: item.content_version,
      p_hash: item.content_hash,
      p_url: verification.final_url,
      p_verification: verification,
      p_key: body.idempotency_key || `${id}:${item.content_version}`,
      p_actor: ctx.user.id,
    });
    return json({
      published: true,
      publication,
      indexing: null,
      observed_citation: null,
    });
  } catch {
    return json(
      {
        error:
          "Publication could not be committed; refresh and retry the same version",
      },
      409,
    );
  }
}
