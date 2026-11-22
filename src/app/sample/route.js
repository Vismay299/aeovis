import { NextResponse } from "next/server";
import { SAMPLE_COOKIE, SAMPLE_COOKIE_MAX_AGE } from "@/shared/sample/mode";

/**
 * Opens the sample workspace: sets the sample cookie and lands on the real
 * portal, which then runs on fictional Brightwave data (src/shared/sample).
 */
export function GET(request) {
  const response = NextResponse.redirect(new URL("/portal", request.url));
  response.cookies.set(SAMPLE_COOKIE, "1", {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: new URL(request.url).protocol === "https:",
    maxAge: SAMPLE_COOKIE_MAX_AGE,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
