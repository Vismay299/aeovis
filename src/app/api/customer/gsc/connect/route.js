import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createOAuthAttempt, isGscOAuthConfigured } from "@/lib/gsc/oauthFlow";
import { hashValue } from "@/lib/gsc/oauthCrypto";

export const dynamic = "force-dynamic";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* ok */ }

  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured.");
  if (!context.user) return fail(401, "Please sign in.");
  if (context.error) return fail(503, "Could not load your workspace access.");

  const key = body?.brand_key || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return fail(404, "That brand is not assigned to your account.");
  if (brand.role !== "owner") return fail(403, "Only workspace owners can connect Google Search Console.");

  if (!isGscOAuthConfigured()) {
    return fail(503, "Google Search Console OAuth is not configured on this deployment.");
  }

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Server is not configured.");

  try {
    // Hash the session token for binding (using the user's session JWT hash).
    const sessionHash = hashValue(context.user.id + ":" + context.user.email);

    const { authorizationUrl } = await createOAuthAttempt({
      userId: context.user.id,
      brandKey: brand.brandKey,
      sessionTokenHash: sessionHash,
      admin,
    });

    return NextResponse.json({ authorization_url: authorizationUrl });
  } catch (error) {
    console.error(`[gsc-oauth] connect failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not start the Google authorization flow.");
  }
}