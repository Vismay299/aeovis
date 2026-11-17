import { NextResponse } from "next/server";
import {
  authorizeOperatorRequest,
  resolveNodeEnv,
  warnDevPerimeterOpen,
  PERIMETER,
} from "@/server/operatorPerimeter";

/**
 * Operator perimeter (R0.1.3). The decision lives in
 * src/server/operatorPerimeter.js so it is unit-testable without a server; this
 * file is only the Next.js binding.
 *
 * Scoped to /api by the matcher below — page routes are untouched, so the
 * marketing site and the scan form still render for anyone.
 */
/**
 * The once-flag for the dev-open disclosure (R0.1.14). Module scope, so it
 * survives between requests handled by the SAME Edge isolate — which is what
 * makes the warning once rather than per-request. Next evaluates this module
 * per isolate, and the platform recycles isolates, so a cold start warns
 * again. Once per isolate, not once per deploy; see warnDevPerimeterOpen.
 */
const warnedDevOpen = { value: false };

export function middleware(request) {
  const { pathname, searchParams } = new URL(request.url);

  if (pathname.startsWith("/api/customer/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
      return NextResponse.json({ error: "Cross-site customer requests are not allowed." }, { status: 403 });
    }
  }

  // Resolved ONCE and reused by the decision and by the disclosure below, so
  // the NODE_ENV the warning names is provably the one that opened the gate.
  const runtimeNodeEnv = resolveNodeEnv(process.env);

  const { allow, reason } = authorizeOperatorRequest({
    method: request.method,
    pathname,
    operatorToken: process.env.OPERATOR_TOKEN,
    // resolveNodeEnv(process.env), never the literal process.env.NODE_ENV:
    // Next inlines that exact expression at build time in the Edge bundle, so
    // writing it here would judge "production" by how this was compiled rather
    // than how it is run. Passing the whole env object is not substituted.
    // Guarded by a test in operatorPerimeter.test.mjs — do not "simplify" it.
    nodeEnv: runtimeNodeEnv,
    header: (name) => request.headers.get(name),
    cookie: (name) => request.cookies.get(name)?.value ?? null,
  });

  if (allow) {
    // An open perimeter must not be a silent one. This is the counterpart of
    // isCronAuthorized's OK_DEV_NO_SECRET warning: with OPERATOR_TOKEN unset
    // and a declared non-production NODE_ENV, every operator route below is
    // unauthenticated, and the only other evidence of that was the source.
    // No-ops for every other allow reason, so the free-scan flow and the
    // self-gated workers stay quiet.
    warnDevPerimeterOpen({
      reason,
      nodeEnv: runtimeNodeEnv,
      method: request.method,
      pathname,
      warned: warnedDevOpen,
    });
    return NextResponse.next();
  }

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
