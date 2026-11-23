import { SAMPLE_COOKIE, isSampleApiPath } from "../shared/sample/mode.js";

/**
 * The server half of sample mode. While the sample cookie is set, the portal's
 * API routes answer 409 without running: the browser answers those requests
 * from fixtures, so a request that reaches the server is one the fixtures
 * missed. Refusing it means sample mode can never read a real workspace, write
 * anything or start paid work, even through a bug in the browser layer.
 */
export function sampleGuardDecision({ pathname, cookie }) {
  if (cookie(SAMPLE_COOKIE) !== "1") return { block: false };
  if (!isSampleApiPath(pathname)) return { block: false };
  return {
    block: true,
    status: 409,
    body: { error: "This is the sample workspace. Sign up to run Perceev on your own brand.", sample: true },
  };
}
