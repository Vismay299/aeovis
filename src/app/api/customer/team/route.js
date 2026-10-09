import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

async function requireOwner(request, explicitKey) {
  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return { response: fail(503, "Customer login is not configured.") };
  if (!context.user) return { response: fail(401, "Please sign in.") };
  if (context.error) return { response: fail(503, "Could not load your workspace access.") };
  const key = explicitKey || new URL(request.url).searchParams.get("brand_key") || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return { response: fail(404, "That brand is not assigned to your account.") };
  if (brand.role !== "owner") return { response: fail(403, "Only workspace owners can manage the team.") };
  return { context, brand };
}

export async function GET(request) {
  const { context, brand, response } = await requireOwner(request);
  if (response) return response;

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Team management is not configured.");

  try {
    const [membersResult, invitesResult] = await Promise.all([
      admin.from("customer_brand_memberships")
        .select("user_id, role, created_at")
        .eq("brand_key", brand.brandKey),
      admin.from("customer_team_invites")
        .select("id, email, role, status, created_at, expires_at")
        .eq("brand_key", brand.brandKey)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);

    if (membersResult.error) throw membersResult.error;
    if (invitesResult.error) throw invitesResult.error;

    // Enrich members with email from auth.users.
    const members = [];
    for (const m of membersResult.data || []) {
      const { data: userData } = await admin.auth.admin.getUserById(m.user_id);
      members.push({
        user_id: m.user_id,
        email: userData?.user?.email || null,
        role: m.role,
        joined_at: m.created_at,
      });
    }

    return NextResponse.json({
      brand_key: brand.brandKey,
      members,
      pending_invites: invitesResult.data || [],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[customer] team list failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not load team members.");
  }
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* rejected below */ }
  const { context, brand, response } = await requireOwner(request, body?.brand_key);
  if (response) return response;

  const email = String(body?.email || "").trim().toLowerCase();
  const role = body?.role === "owner" ? "owner" : "member";
  if (!email || !email.includes("@")) return fail(400, "A valid email is required.");

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Team management is not configured.");

  try {
    // Check if user already has a membership.
    const { data: existing } = await admin.from("customer_brand_memberships")
      .select("user_id")
      .eq("brand_key", brand.brandKey)
      .limit(50);

    // Look up the user by email.
    let targetUser = null;
    for (let page = 1; page <= 10; page++) {
      const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      const found = data?.users?.find((u) => u.email?.toLowerCase() === email);
      if (found) { targetUser = found; break; }
      if (!data?.users?.length || data.users.length < 1000) break;
    }

    if (targetUser) {
      const alreadyMember = (existing || []).some((m) => m.user_id === targetUser.id);
      if (alreadyMember) return fail(409, "This person is already a team member.");

      const { error: membershipError } = await admin.from("customer_brand_memberships").insert({
        user_id: targetUser.id,
        brand_key: brand.brandKey,
        role,
      });
      if (membershipError) {
        if (membershipError.code === "23505") return fail(409, "This person is already a team member.");
        throw membershipError;
      }
      return NextResponse.json({ added: true, email, role, user_exists: true }, { status: 201 });
    }

    // User doesn't exist yet — create an invite.
    const { data: invitation, error: inviteError } = await admin.from("customer_team_invites").insert({
      brand_key: brand.brandKey,
      email,
      role,
      invited_by: context.user.id,
    }).select("id").single();
    if (inviteError) {
      if (inviteError.code === "23505") return fail(409, "An invite for this email is already pending.");
      throw inviteError;
    }

    // Send the Supabase invite email.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || new URL(request.url).origin;
    const redirectTo = `${appUrl}/auth/callback?next=/auth/accept`;
    const { error: sendError } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (sendError) {
      const { error: cleanupError } = await admin.from("customer_team_invites").delete().eq("id", invitation.id);
      if (cleanupError) console.error("[customer] failed invite cleanup:", cleanupError);
      throw new Error("Could not send the invitation email.");
    }

    return NextResponse.json({ invited: true, email, role, user_exists: false }, { status: 201 });
  } catch (error) {
    console.error(`[customer] team invite failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not add this team member.");
  }
}

export async function DELETE(request) {
  let body = {};
  try { body = await request.json(); } catch { /* rejected below */ }
  const { brand, response } = await requireOwner(request, body?.brand_key);
  if (response) return response;

  const targetUserId = body?.user_id;
  if (!targetUserId) return fail(400, "user_id is required.");

  const admin = getSupabaseAdmin();
  if (!admin) return fail(503, "Team management is not configured.");

  try {
    // The database trigger prevents removing the last owner.
    const { error } = await admin.from("customer_brand_memberships")
      .delete()
      .eq("brand_key", brand.brandKey)
      .eq("user_id", targetUserId);

    if (error) {
      if (error.message?.includes("last owner")) return fail(409, "Cannot remove the last owner of a workspace.");
      throw error;
    }

    return NextResponse.json({ removed: true });
  } catch (error) {
    console.error(`[customer] team remove failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not remove this team member.");
  }
}