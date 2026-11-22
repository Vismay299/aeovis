import { NextResponse } from "next/server";
import { SAMPLE_COOKIE } from "@/shared/sample/mode";

/** Leaves the sample workspace. `?to=/signup` sends the visitor on to sign up. */
export function GET(request) {
  const url = new URL(request.url);
  const to = url.searchParams.get("to");
  const target = to && to.startsWith("/") && !to.startsWith("//") ? to : "/";
  // Relative, for the same reason as /sample.
  const response = new NextResponse(null, { status: 307, headers: { Location: target } });
  response.cookies.set(SAMPLE_COOKIE, "", { path: "/", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
