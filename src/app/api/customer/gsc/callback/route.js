import { NextResponse } from "next/server";
import { getCustomerContext } from "@/lib/supabase/customer";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleOAuthCallback } from "@/lib/gsc/oauthFlow";
import { customerSessionBinding } from "@/lib/supabase/sessionBinding";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || new URL(request.url).origin;
  const portalUrl = `${appUrl}/portal/search-console`;

  // Handle consent denial or errors from Google.
  if (error) {
    const message = error === "access_denied"
      ? "Google authorization was cancelled."
      : `Google authorization error: ${error}`;
    return NextResponse.redirect(`${portalUrl}?gsc_error=${encodeURIComponent(message)}`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${portalUrl}?gsc_error=${encodeURIComponent("Missing authorization code or state.")}`);
  }

  // Validate the user session.
  const context = await getCustomerContext();
  if (!context.user) {
    return NextResponse.redirect(`${appUrl}/login?next=${encodeURIComponent("/portal/search-console")}`);
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.redirect(`${portalUrl}?gsc_error=${encodeURIComponent("Server is not configured.")}`);
  }

  try {
    const sessionHash = await customerSessionBinding(context);
    if (!sessionHash) throw new Error("Your login session expired. Please sign in again.");
    const result = await handleOAuthCallback({
      state,
      code,
      sessionTokenHash: sessionHash,
      userId: context.user.id,
      admin,
    });

    if (result.returnPath === "/onboarding") {
      return NextResponse.redirect(`${appUrl}/onboarding?step=search_console&gsc_connected=true&brand_key=${encodeURIComponent(result.brandKey)}&gsc_attempt=${encodeURIComponent(result.attemptId)}`);
    }

    // Redirect to the portal with the brand key so the UI can show the property picker.
    return NextResponse.redirect(`${portalUrl}?gsc_connected=true&brand_key=${encodeURIComponent(result.brandKey)}&gsc_attempt=${encodeURIComponent(result.attemptId)}`);
  } catch (callbackError) {
    console.error("[gsc-oauth] callback failed:", callbackError);
    return NextResponse.redirect(`${portalUrl}?gsc_error=${encodeURIComponent(callbackError.message || "Authorization failed.")}`);
  }
}