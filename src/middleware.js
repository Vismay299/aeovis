import { NextResponse } from "next/server";
import { authorizeOperatorRequest, resolveNodeEnv, PERIMETER } from "@/lib/operatorPerimeter";

/**
 * Operator perimeter (R0.1.3). The decision lives in
 * src/lib/operatorPerimeter.js so it is unit-testable without a server; this
 * file is only the Next.js binding.
 *
 * Scoped to /api by the matcher below — page routes are untouched, so the
 * marketing site and the scan form still render for anyone.
 */
export function middleware(request) {
  const { pathname, searchParams } = new URL(request.url);

  const { allow, reason } = authorizeOperatorRequest({
    method: request.method,
    pathname,
    operatorToken: process.env.OPERATOR_TOKEN,
    // resolveNodeEnv(process.env), never the literal process.env.NODE_ENV:
    // Next inlines that exact expression at build time in the Edge bundle, so
    // writing it here would judge "production" by how this was compiled rather
    // than how it is run. Passing the whole env object is not substituted.
    // Guarded by a test in operatorPerimeter.test.mjs — do not "simplify" it.
    nodeEnv: resolveNodeEnv(process.env),
    header: (name) => request.headers.get(name),
    cookie: (name) => request.cookies.get(name)?.value ?? null,
  });

  if (allow) return NextResponse.next();

  if (reason === PERIMETER.DENY_NO_TOKEN_CONFIGURED) {
    console.error(
      `[perimeter] REFUSING ${request.method} ${pathname}: OPERATOR_TOKEN is not set in production.`
    );
  }

  return NextResponse.json(
    {
      detail:
        reason === PERIMETER.DENY_NO_TOKEN_CONFIGURED
          ? "This deployment has no operator token configured; operator routes are closed."
          : "Operator credentials required.",
    },
    { status: 401 }
  );
}

export const config = {
  // Only API routes. Static assets, _next and page routes never reach here.
  matcher: ["/api/:path*"],
};
