import { NextResponse } from "next/server";
import { createCustomerSupabaseClient } from "@/shared/supabase/customer";
import { authErrorCodeFrom } from "@/shared/auth-errors";
import { normalizeAuthRedirect } from "@/shared/auth-redirect";
import { isFirstSession, trackAuthServerEvent } from "@/server/auth/telemetry";
import { isFeatureEnabled } from "@/server/features/flags";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { enqueueSignupEmails } from "@/server/email/signup";
import { SAMPLE_COOKIE } from "@/shared/sample/mode";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);

  // Handle OAuth / authentication error parameters before any session exchange
  const errorParam = url.searchParams.get("error");
  const errorCodeParam = url.searchParams.get("error_code");
  const errorDescriptionParam = url.searchParams.get("error_description");

  if (errorParam || errorCodeParam) {
    const code = authErrorCodeFrom({
      error: errorParam,
      errorCode: errorCodeParam,
      description: errorDescriptionParam,
    });
    // An expired email link goes to the verify page, which offers a resend; other
    // errors go to /auth/error. Both keep a safe `next` (onboarding hand-off).
    const next = normalizeAuthRedirect(url.searchParams.get("next"));
    const errorUrl = new URL(code === "link_expired" ? "/auth/verify" : "/auth/error", url.origin);
    errorUrl.searchParams.set("error", code);
    if (next !== "/portal") errorUrl.searchParams.set("next", next);
    return NextResponse.redirect(errorUrl, { status: 303 });
  }

  const client = await createCustomerSupabaseClient();
  const nextParam = url.searchParams.get("next");
  const destination = new URL(normalizeAuthRedirect(nextParam), url.origin);

  if (!client) {
    destination.pathname = "/login";
    destination.searchParams.set("error", "auth_not_configured");
    return NextResponse.redirect(destination);
  }

  let error = null;
  let data = null;
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (code) {
    ({ data, error } = await client.auth.exchangeCodeForSession(code));
  } else if (tokenHash && ["invite", "recovery", "email", "signup"].includes(type)) {
    ({ data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type }));
  } else if (["/auth/accept", "/auth/reset"].includes(destination.pathname)) {
    // The browser retains the original fragment across this redirect. Those
    // pages consume implicit tokens, which are never sent to the server.
    return NextResponse.redirect(destination);
  } else {
    error = new Error("The sign-in link is missing its one-time code.");
  }

  if (!error) {
    // First-session detection for new-account telemetry. The exchange already
    // returned the user, so there is no extra Auth round trip.
    try {
      const user = data?.user ?? data?.session?.user ?? null;
      if (user && isFirstSession(user, Date.now())) {
        const provider = user.app_metadata?.provider ?? "email";
        trackAuthServerEvent(
          "auth:sign_up_completed",
          {
            method: provider === "google" ? "google" : "email",
            from_free_scan: destination.searchParams.has("scan"),
            from_domain: destination.searchParams.has("domain"),
          },
          user.id
        );
        if (await isFeatureEnabled("lifecycle_email")) {
          const admin = getSupabaseAdmin();
          if (admin) {
            await enqueueSignupEmails(admin, user);
          }
        }
      }
    } catch {
      // Best-effort telemetry and email enqueue
    }

    const { error: inviteError } = await client.rpc("accept_customer_team_invites");
    if (inviteError) {
      console.error("[customer] invite redemption failed:", inviteError);
      destination.pathname = "/auth/accept";
    }
  }

  if (error) {
    destination.pathname = "/login";
    destination.search = "";
    destination.searchParams.set("error", "link_expired");
  }

  const response = NextResponse.redirect(destination);
  // A real sign-in always leaves the sample workspace.
  if (request.cookies?.get?.(SAMPLE_COOKIE)) response.cookies.set(SAMPLE_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
