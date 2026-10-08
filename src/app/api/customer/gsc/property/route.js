import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { listOAuthProperties, getValidAccessToken } from "@/lib/gsc/oauthFlow";

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

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    // Verify the user still has access to this property through their own authorization.
    const properties = await listOAuthProperties({ brandKey: brand.brandKey, admin });
    const chosen = properties.find((p) => p.siteUrl === propertyId);
    if (!chosen) {
      return fail(422, "This property is not available through your Google authorization.");
    }

    // Verify the property matches the workspace website.
    const propHost = parseHostname(propertyId);
    const workspaceHost = brand.website_host?.toLowerCase().replace(/^www\./, "");
    if (propHost && workspaceHost && propHost !== workspaceHost && !propHost.endsWith(`.${workspaceHost}`) && !workspaceHost.endsWith(`.${propHost}`)) {
      return fail(422, `The selected property "${propertyId}" does not match your workspace website (${brand.website}).`);
    }

    // Get the credential ID.
    const { data: cred } = await admin
      .from("gsc_oauth_credentials")
      .select("id")
      .eq("brand_key", brand.brandKey)
      .eq("status", "active")
      .single();

    // Activate the connection. Increment generation if replacing a property.
    const { data: existingConn } = await admin
      .from("gsc_connections")
      .select("connection_generation, site_url")
      .eq("brand_key", brand.brandKey)
      .single();

    const isNewProperty = existingConn && existingConn.site_url !== propertyId;
    const generation = isNewProperty ? (existingConn?.connection_generation || 0) + 1 : (existingConn?.connection_generation || 1);

    const { error: connError } = await admin.from("gsc_connections").upsert({
      brand: brand.brandKey,
      brand_key: brand.brandKey,
      site_url: propertyId,
      enabled: true,
      auth_mode: "oauth",
      credential_id: cred?.id || null,
      connection_generation: generation,
      permission_level: chosen.permissionLevel || null,
    }, { onConflict: "brand" });

    if (connError) throw new Error(`Failed to activate connection: ${connError.message}`);

    // Queue the initial sync job.
    const { error: syncError } = await admin.from("gsc_sync_jobs").insert({
      brand_key: brand.brandKey,
      connection_generation: generation,
      sync_type: existingConn ? "incremental" : "initial",
    });

    if (syncError) console.error("[gsc-oauth] sync job enqueue failed:", syncError);

    // Reset the gsc_daily watermark for the new generation if property changed.
    if (isNewProperty) {
      await admin.from("gsc_connections")
        .update({ last_ingested_through: null, last_status: null, last_error: null, last_attempt_at: null })
        .eq("brand", brand.brandKey);
    }

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