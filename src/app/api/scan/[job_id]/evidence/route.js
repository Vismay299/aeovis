import { getScanJob } from "@/lib/db";
import {
  EVIDENCE_SIGNED_URL_TTL_SECONDS,
  EVIDENCE_SIGN_REASONS,
  signEvidenceForResult,
} from "@/lib/evidenceSignedUrl";

// Signs a Storage object per request — never prerendered, never cached.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/scan/[job_id]/evidence?result=<prompt_result_id>&kind=screenshot
 *
 * R1.5.3 — "View evidence" in AnswersView points here. The answer is a 302 to a
 * signed URL for the object whose key is stored on that result row, valid for
 * EVIDENCE_SIGNED_URL_TTL_SECONDS.
 *
 * THE PERIMETER IS THE ONE THE SCAN ROUTES ALREADY HAVE, and it is worth saying
 * out loud rather than implying: scans are UNAUTHENTICATED today. Its sibling,
 * GET /api/scan/[job_id]/status, has no session, no cookie and no bearer — it
 * 404s an unknown job id and serves any known one. So does this route. And the
 * entry cost is lower than "holding the job uuid": the already-public
 * GET /api/scans/<brand> returns raw_results.results, which carries job_id and
 * result_id — so knowing the BRAND is what gets you in, exactly as it already
 * gets you the job's answers. Inventing a session check here would be a second,
 * different perimeter around one scan, and the first door would still be open.
 * When scans get an owner, both routes change together. Concretely: this path
 * is listed in `src/lib/operatorPerimeter.js`'s free-scan allowlist (GET only),
 * beside the status poll, and that addition is asserted deliberately in
 * operatorPerimeter.test.mjs's "is that deliberate?" set.
 *
 * What this route DOES add over "knows a uuid" is scoping: the result row must
 * belong to the job in the path, and the object key is read off that row. A
 * caller can never name an object (see src/lib/evidenceSignedUrl.js).
 *
 * WHY A 302 AND NOT `{ url }` JSON:
 *   * The affordance is a plain `<a target="_blank">`. A link cannot be
 *     popup-blocked, which a `window.open` after an `await fetch` regularly is.
 *   * The signed URL never enters the DOM, the page's JS or a client-side error
 *     report — only the browser's navigation sees it.
 *   * Refusals (no capture, no such result) render as a readable sentence in the
 *     tab the user just opened, instead of a dead tab and a console error.
 * The cost is that the redirect target can land in browser history; the short
 * TTL is what bounds that, and is why the TTL is short.
 *
 * Every refusal has a plain-text body. NULL evidence is 404 with a sentence —
 * never a fabricated URL, never a redirect to an object that does not exist.
 */

function plain(detail, status) {
  return new Response(`${detail}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

export async function GET(request, context = {}, deps = {}) {
  const params = context?.params || {};
  const jobId = params.job_id;
  if (!jobId) return plain("Job ID is required.", 400);

  const { searchParams } = new URL(request.url);
  const resultId = searchParams.get("result") || "";
  const kind = searchParams.get("kind") || "screenshot";

  const readJob = deps.getScanJob || getScanJob;
  let job;
  try {
    job = await readJob(jobId);
  } catch (error) {
    console.error(`[evidence] scan job ${jobId} unreadable:`, error);
    return plain(
      "The scan job could not be read, so this evidence link could not be resolved. Try again.",
      503
    );
  }
  if (!job) return plain("Job not found.", 404);

  const outcome = await (deps.signEvidenceForResult || signEvidenceForResult)(
    { jobId, resultId, kind },
    deps
  );

  if (!outcome.ok) {
    if (outcome.reason === EVIDENCE_SIGN_REASONS.LOOKUP_FAILED || outcome.reason === EVIDENCE_SIGN_REASONS.SIGN_FAILED) {
      console.error(`[evidence] job ${jobId} result ${resultId} (${kind}): ${outcome.detail}`);
    }
    return plain(outcome.detail, outcome.status);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: outcome.url,
      // The signed URL is single-use in spirit: nothing may cache it, and the
      // target must not learn which dashboard page produced the click.
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Referrer-Policy": "no-referrer",
      "X-Evidence-Expires-In": String(outcome.expiresInSeconds ?? EVIDENCE_SIGNED_URL_TTL_SECONDS),
    },
  });
}
