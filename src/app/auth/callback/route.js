import { NextResponse } from "next/server";
import { createCustomerSupabaseClient } from "@/lib/supabase/customer";
import { authErrorCodeFrom } from "@/shared/auth-errors";
import { trackAuthServerEvent } from "@/lib/auth/telemetry";

export const dynamic = "force-dynamic";

function safeNext(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/portal";
}

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
    const errorUrl = new URL(`/auth/error?error=${encodeURIComponent(code)}`, url.origin);
    return NextResponse.redirect(errorUrl, { status: 303 });
  }

  const client = await createCustomerSupabaseClient();
  const nextParam = url.searchParams.get("next");
  const destination = new URL(safeNext(nextParam), url.origin);

  if (!client) {
    destination.pathname = "/login";
    destination.searchParams.set("error", "auth_not_configured");
    return NextResponse.redirect(destination);
  }

  let error = null;
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (code) {
    ({ error } = await client.auth.exchangeCodeForSession(code));
  } else if (tokenHash && ["invite", "recovery", "email", "signup"].includes(type)) {
    ({ error } = await client.auth.verifyOtp({ token_hash: tokenHash, type }));
  } else if (["/auth/accept", "/auth/reset"].includes(destination.pathname)) {
    // The browser retains the original fragment across this redirect. Those
    // pages consume implicit tokens, which are never sent to the server.
    return NextResponse.redirect(destination);
  } else {
    error = new Error("The sign-in link is missing its one-time code.");
  }

  if (!error) {
    // First-session detection for new account telemetry
    try {
      const { data: { user } = {} } = await client.auth.getUser();
      if (user?.created_at && user?.last_sign_in_at) {
        const createdMs = new Date(user.created_at).getTime();
        const lastSignInMs = new Date(user.last_sign_in_at).getTime();
        const tenMinutes = 10 * 60 * 1000;
        const now = Date.now();
        const isRecent = Math.abs(now - createdMs) <= tenMinutes;
        const isFirstSession = Math.floor(createdMs / 1000) === Math.floor(lastSignInMs / 1000);

        if (isRecent && isFirstSession) {
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
        }
      }
    } catch {
      // Best-effort telemetry
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

  return NextResponse.redirect(destination);
}
