import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { findCustomerBrandAliasConflict, normalizeCustomerBrand, registerCustomerBrandAliases } from "@/lib/customerProvisioning";

export const dynamic = "force-dynamic";

async function findExistingAuthUser(admin, email) {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return { user: null, error };
    const users = data?.users || [];
    const user = users.find((candidate) => String(candidate.email || "").toLowerCase() === email);
    if (user) return { user, error: null };
    if (users.length < 1000) return { user: null, error: null };
  }
  return { user: null, error: new Error("Auth user search exceeded its safety limit.") };
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* rejected below */ }
  const email = String(body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json({ error: "A valid customer email is required." }, { status: 400 });
  }
  const normalized = normalizeCustomerBrand({ brandKey: body?.brand_key, brandName: body?.brand_name, website: body?.website });
  if (normalized.error) return NextResponse.json({ error: normalized.error }, { status: 400 });

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is required to send customer invitations." }, { status: 503 });

  const aliasCheck = await findCustomerBrandAliasConflict(admin, normalized.value);
  if (aliasCheck.error) {
    console.error("[customer] brand alias collision check failed:", aliasCheck.error);
    return NextResponse.json({ error: "Could not check for an existing brand name." }, { status: 500 });
  }
  if (aliasCheck.conflict) {
    return NextResponse.json({ error: "That brand name is already associated with another customer workspace." }, { status: 409 });
  }

  let brandCreated = false;
  const existingBrand = await admin.from("customer_brands")
    .select("brand_key")
    .eq("brand_key", normalized.value.brand_key)
    .limit(1);
  if (existingBrand.error) {
    console.error("[customer] existing brand lookup failed:", existingBrand.error);
    return NextResponse.json({ error: "Could not prepare this customer workspace." }, { status: 500 });
  }
  if (!existingBrand.data?.length) {
    const { error } = await admin.from("customer_brands").insert({ ...normalized.value, aliases: [] });
    if (error && error.code !== "23505") {
      console.error("[customer] brand provisioning failed:", error);
      return NextResponse.json({ error: "Could not prepare this customer workspace." }, { status: 500 });
    }
    brandCreated = !error;
  }

  const aliasRegistration = await registerCustomerBrandAliases(admin, normalized.value);
  if (aliasRegistration.error || aliasRegistration.conflict) {
    if (brandCreated) {
      const cleanup = await admin.from("customer_brands").delete().eq("brand_key", normalized.value.brand_key);
      if (cleanup.error) console.error("[customer] failed to clean up an unassigned workspace:", cleanup.error);
    }
    if (aliasRegistration.conflict) {
      return NextResponse.json({ error: "That brand name is already associated with another customer workspace." }, { status: 409 });
    }
    console.error("[customer] brand alias registration failed:", aliasRegistration.error);
    return NextResponse.json({ error: "Could not securely register this brand name." }, { status: 500 });
  }
  const { error: brandError } = await admin.from("customer_brands")
    .upsert({ ...normalized.value, aliases: aliasRegistration.aliases }, { onConflict: "brand_key" });
  if (brandError) {
    if (brandCreated) {
      const cleanup = await admin.from("customer_brands").delete().eq("brand_key", normalized.value.brand_key);
      if (cleanup.error) console.error("[customer] failed to clean up an unassigned workspace:", cleanup.error);
    }
    console.error("[customer] brand provisioning failed:", brandError);
    return NextResponse.json({ error: "Could not prepare this customer workspace." }, { status: 500 });
  }

  const requestUrl = new URL(request.url);
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL || requestUrl.origin;
  const callback = new URL("/auth/callback", configuredOrigin);
  callback.searchParams.set("next", "/auth/accept");

  const { data, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: callback.toString(),
    data: { display_name: normalized.value.display_name },
  });
  let user = data?.user || null;
  let existingAccount = false;
  if (inviteError || !user) {
    const existing = await findExistingAuthUser(admin, email);
    if (existing.error) {
      console.error("[customer] existing account lookup failed:", existing.error);
      return NextResponse.json({ error: "Could not check whether this email already has an account." }, { status: 503 });
    }
    user = existing.user;
    existingAccount = !!user;
  }
  if (!user?.id) {
    console.error("[customer] invitation failed:", inviteError);
    return NextResponse.json({ error: "Could not send this invitation. The email may already have an account." }, { status: 409 });
  }

  const { error: membershipError } = await admin.from("customer_brand_memberships")
    .upsert({ user_id: user.id, brand_key: normalized.value.brand_key, role: "owner" }, { onConflict: "user_id,brand_key" });
  if (membershipError) {
    console.error("[customer] invitation membership save failed:", membershipError);
    if (!existingAccount) {
      const cleanup = await admin.auth.admin.deleteUser(user.id);
      if (cleanup.error) console.error("[customer] failed to clean up an unassigned invite:", cleanup.error);
    }
    return NextResponse.json({ error: "The invitation could not be assigned to its workspace. Please retry." }, { status: 500 });
  }

  return NextResponse.json({ invited: !existingAccount, account_linked: existingAccount, email, brand_key: normalized.value.brand_key }, { status: 201 });
}
