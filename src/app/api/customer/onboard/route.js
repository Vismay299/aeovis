import crypto from "crypto";
import { NextResponse } from "next/server";
import { getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { planCustomerOnboarding } from "@/lib/customerOnboarding";
import { normalizeCustomerBrand } from "@/lib/customerProvisioning";

export const dynamic = "force-dynamic";

function fail(status, error, extra = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

async function currentUser() {
  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return { response: fail(503, "Customer login is not configured on this deployment.") };
  if (!context.user) return { response: fail(401, "Please verify your email and sign in to continue.") };
  if (context.error) return { response: fail(503, "Your account could not be checked. Please retry.") };
  if (!context.user.email_confirmed_at && !context.user.confirmed_at) {
    return { response: fail(403, "Verify your email before creating a workspace.") };
  }
  if (context.brands.length) return { context, hasWorkspace: true };
  return { context, hasWorkspace: false };
}

export async function GET() {
  const { response, hasWorkspace } = await currentUser();
  if (response) return response;
  return NextResponse.json({
    has_workspace: hasWorkspace,
    gsc_optional: true,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const { context, response, hasWorkspace } = await currentUser();
  if (response) return response;
  if (hasWorkspace) return fail(409, "Your account already has a workspace.");

  let body = {};
  try { body = await request.json(); } catch { /* rejected by validation below */ }

  const idempotencyKey = body?.idempotency_key || crypto.randomUUID();
  const normalized = normalizeCustomerBrand({ brandName: body?.brand_name, website: body?.website });
  if (normalized.error) return fail(400, normalized.error);

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Customer workspace creation is not configured on this deployment yet.");

  // Check for alias collisions (the host uniqueness is removed, but aliases still matter).
  const aliasCheck = await findAliasConflict(admin, normalized.value);
  if (aliasCheck.error) {
    console.error("[customer] self-service workspace alias check failed:", aliasCheck.error);
    return fail(500, "Could not check whether this brand already has a workspace.");
  }

  // Use the transactional RPC for workspace creation.
  const { data: rpcResult, error: rpcError } = await admin.rpc("create_customer_workspace", {
    p_brand_key: normalized.value.brand_key,
    p_display_name: normalized.value.display_name,
    p_website: normalized.value.website,
    p_website_host: normalized.value.website_host,
    p_user_id: context.user.id,
    p_idempotency_key: idempotencyKey,
    p_aliases: normalized.value.aliases,
  });

  if (rpcError) {
    if (rpcError.code === "23505") {
      return fail(409, "This brand already has a workspace. Ask your Perceev contact to assign your account.");
    }
    console.error("[customer] self-service workspace creation failed:", rpcError);
    return fail(500, "Could not create the brand workspace.");
  }

  const result = typeof rpcResult === "string" ? JSON.parse(rpcResult) : rpcResult;

  return NextResponse.json({
    created: result.created,
    brand_key: result.brand_key,
    gsc_available: true,
    gsc_message: "You can connect Google Search Console from your workspace to import search data.",
  }, { status: result.created ? 201 : 200, headers: { "Cache-Control": "no-store" } });
}

async function findAliasConflict(admin, brand) {
  const aliases = [...new Set([brand.brand_key, ...(brand.aliases || [])]
    .map((v) => String(v || "").trim().toLowerCase()).filter(Boolean))];
  if (!aliases.length) return { error: null, conflict: null };
  const { data, error } = await admin.from("customer_brand_aliases")
    .select("alias, brand_key")
    .in("alias", aliases);
  if (error) return { error, conflict: null };
  const row = (data || []).find((c) => c.brand_key !== brand.brand_key);
  return { error: null, conflict: row || null };
}