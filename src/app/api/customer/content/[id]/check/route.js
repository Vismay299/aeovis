import { NextResponse } from "next/server";
import { customerRouteContext } from "@/lib/supabase/customerRoute";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { runFactCheck } from "@/lib/content/steps/factCheck";
import { draftCheck } from "@/lib/repairs/workflow";
export const dynamic = "force-dynamic";
export async function POST(request, { params }) {
  const { id } = await params;
  const ctx = await customerRouteContext(request);
  if (ctx.response) return ctx.response;
  const admin = getSupabaseAdmin();
  if (!admin)
    return NextResponse.json(
      { error: "Checking unavailable" },
      { status: 503 },
    );
  const { data: item, error } = await ctx.client
    .from("content_items")
    .select("*")
    .eq("id", id)
    .eq("brand", ctx.brand.brandKey)
    .maybeSingle();
  if (error)
    return NextResponse.json(
      { error: "Could not load draft" },
      { status: 503 },
    );
  if (!item)
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  const input = await request.json().catch(() => ({}));
  if (
    input.content_hash !== item.content_hash ||
    input.content_version !== item.content_version
  )
    return NextResponse.json(
      { error: "Draft changed; refresh before checking" },
      { status: 409 },
    );
  const cap = Number(process.env.CONTENT_MAX_COST_PER_ITEM || 0.15);
  const key = `${id}:${item.content_version}:${item.content_hash}`;
  const { data: claim, error: claimError } = await admin.rpc(
    "claim_content_check",
    {
      p_item: id,
      p_brand: ctx.brand.brandKey,
      p_version: item.content_version,
      p_hash: item.content_hash,
      p_key: key,
      p_reserve: 0.02,
      p_cap: cap,
    },
  );
  if (claimError)
    return NextResponse.json(
      { error: "Could not reserve checking budget" },
      { status: 409 },
    );
  if (!claim.granted)
    return claim.state === "complete"
      ? NextResponse.json({ check: claim.check, reused: true })
      : NextResponse.json(
          {
            error: claim.state === "budget_exhausted" ? "This draft has reached its checking budget. Review the budget before another paid check." : claim.state === "unknown" ? "The previous check has an unknown result. An operator must reconcile it before another paid check." : "A check of this saved version is already running. Refresh to see its result.",
            state: claim.state,
          },
          { status: 409 },
        );
  const stats = { cost: 0, tokens: 0 };
  try {
    const verdict = await runFactCheck({
      brand: item.brand,
      draft: { title: item.title, body_md: item.body_md },
      researchPack: item.research_pack,
      stats,
      input: {},
    });
    const check = draftCheck(item, item.research_pack, verdict);
    const { data: saved, error: writeError } = await admin.rpc(
      "finish_content_check",
      {
        p_item: id,
        p_brand: ctx.brand.brandKey,
        p_key: key,
        p_token: claim.token,
        p_check: check,
        p_cost: stats.cost_unmeasured_calls ? null : stats.cost,
      },
    );
    if (writeError || !saved.applied)
      return NextResponse.json(
        { error: "The check was not applied; reload the current version" },
        { status: 409 },
      );
    return NextResponse.json({ check, content_version: item.content_version });
  } catch {
    await admin.rpc("finish_content_check", {
      p_item: id,
      p_brand: ctx.brand.brandKey,
      p_key: key,
      p_token: claim.token,
      p_check: null,
      p_cost: null,
    });
    return NextResponse.json(
      { error: "The check did not complete; approval remains unavailable" },
      { status: 503 },
    );
  }
}
