import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/shared/supabase/customer";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { listOAuthProperties } from "@/server/gsc/oauthFlow";

import { wakeGscWorker } from "@/server/gsc/syncJobs";

export const dynamic = "force-dynamic";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function parseHostname(propertyId) {
  // "sc-domain:example.com" → "example.com", "https://example.com/" → "example.com"
  if (!propertyId) return null;
  if (propertyId.startsWith("sc-domain:")) return propertyId.slice(10).toLowerCase().replace(/^www\./, "");
  try {
    return new URL(propertyId).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* rejected below */ }

  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured.");
  if (!context.user) return fail(401, "Please sign in.");
  if (context.error) return fail(503, "Could not load your workspace access.");

  const key = body?.brand_key || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return fail(404, "That brand is not assigned to your account.");
  if (brand.role !== "owner") return fail(403, "Only workspace owners can change Google Search Console settings.");

  const propertyId = String(body?.property_id || "").trim();
  if (!propertyId) return fail(400, "property_id is required.");
  const attemptId = String(body?.attempt_id || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return fail(400, "A pending Google authorization is required.");

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    // Verify the user still has access to this property through their own authorization.
    const properties = await listOAuthProperties({ brandKey: brand.brandKey, admin, attemptId, userId: context.user.id });
    const chosen = properties.find((p) => p.siteUrl === propertyId);
    if (!chosen || chosen.permissionLevel === "siteUnverifiedUser") {
      return fail(422, "This property is not available through your Google authorization.");
    }

    // Verify the property matches the workspace website.
    const propHost = parseHostname(propertyId);
    const workspaceHost = brand.website_host?.toLowerCase().replace(/^www\./, "");
    if (!propHost || !workspaceHost || propHost !== workspaceHost) {
      return fail(422, `The selected property "${propertyId}" does not match your workspace website (${brand.website}).`);
    }

    const { data: generation, error: activationError } = await admin.rpc("activate_customer_gsc", {
      p_brand_key: brand.brandKey, p_user_id: context.user.id, p_attempt_id: attemptId,
      p_site_url: propertyId, p_permission: chosen.permissionLevel || null,
    });
    if (activationError) throw new Error("Could not activate the selected property.", { cause: activationError });

    wakeGscWorker(brand.brandKey);
    return NextResponse.json({
      connected: true,
      property_id: propertyId,
      property: chosen,
      generation,
    }, { status: 201 });
  } catch (error) {
    console.error(`[gsc-oauth] property selection failed for ${brand.brandKey}:`, error);
    return fail(500, error.message || "Could not activate the selected property.");
  }
}