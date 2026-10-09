import { NextResponse } from "next/server";
import { createCustomerSupabaseClient } from "@/lib/supabase/customer";

export const dynamic = "force-dynamic";

function safeNext(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/portal";
}

export async function GET(request) {
  const url = new URL(request.url);
  const client = await createCustomerSupabaseClient();
  const destination = new URL(safeNext(url.searchParams.get("next")), url.origin);

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
    const { error: inviteError } = await client.rpc("accept_customer_team_invites");
    if (inviteError) {
      console.error("[customer] invite redemption failed:", inviteError);
      destination.pathname = "/auth/accept";
    }
  }
  if (error) {
    destination.pathname = "/login";
    destination.searchParams.set("error", "link_expired");
  }
  return NextResponse.redirect(destination);
}
