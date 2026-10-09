import { NextResponse } from "next/server";
import { createScanJob, hasActiveScanForBrand, supabase } from "@/lib/db";
import { DuplicateScanError } from "@/lib/duplicateScan";
import { BUCKET_SCOPE, checkScanRateLimit } from "@/lib/rateLimit";
import { incrementScanRateLimit } from "@/lib/db/analytics";
import { runScanChunk } from "@/lib/workers/scanWorker";
import { keepAlive } from "@/lib/keepAlive";

// A chunk can run for up to ~150s (CHUNK_TIME_BUDGET_MS in scanWorker.js)
// plus finalize; give the fire-and-forget first chunk kicked off below room
// to make real progress before the platform would otherwise cut it off.
export const maxDuration = 300;

/**
 * R0.1.21 — the one refusal this route owes an anonymous caller when the scan
 * store is not there.
 *
 * `createScanJob` (src/lib/db.js) fail-softs to `global.memoryJobs` whenever
 * there is no Supabase client. That map is legitimate for local development
 * and for the test suite, and it is a lie on a deployed instance: it is
 * per-process, so no worker invocation, no status poll on another instance and
 * no `scans` row ever sees the job. Returning 201 off it hands a stranger a
 * job id for a scan that was never persisted, and then `runScanChunk` spends
 * real Bright Data + Perplexity + LLM budget producing results with nowhere to
 * land. That is what R0.1.4's negative control actually hit.
 *
 * 503, not 4xx: nothing about the request is wrong. The deployment is. And not
 * 201-with-a-warning — a caller cannot poll a job that does not exist, so a
 * degraded success is just a slower failure. See
 * docs/decisions/2026-09-05-unpersisted-scan-jobs.md.
 *
 * The body names no vendor and no infrastructure (R6.4.3): "supabase" in an
 * anonymous 503 is free reconnaissance. The operator-facing detail goes to the
 * server log instead, where it names the env vars that are missing — never
 * their values.
 */
function scanStoreUnavailable(reason) {
  console.error(
    `[scan] REFUSED 503: ${reason} A scan job could only have been created in the ` +
      "in-memory dev store (global.memoryJobs), which is per-process and invisible to every " +
      "worker, status poll and scans row. Refusing rather than returning 201 for a scan that " +
      "was never persisted; no vendor calls were made. Check that NEXT_PUBLIC_SUPABASE_URL, " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are set on this deployment."
  );
  return NextResponse.json(
    {
      detail: "Scans are temporarily unavailable. No scan was started — please try again later.",
      code: "scan_store_unavailable",
    },
    { status: 503 }
  );
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    const url = (payload.url || "").trim();
    const industry = (payload.industry || "").trim();
    const competitors = (payload.competitors || "").trim();
    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }

    // R0.1.4: the free scan is anonymous and spends real Bright Data +
    // Perplexity + LLM budget per call. Counted BEFORE the duplicate check so
    // a caller cannot probe for free by hammering an already-scanning brand.
    const rate = await checkScanRateLimit({
      header: (name) => request.headers.get(name),
      increment: (args) => incrementScanRateLimit(args),
    });
    if (!rate.allowed) {
      // R0.1.22. Off Vercel with no trusted address source, the limit that binds
      // is a ceiling every unverified caller SHARES, so "too many scans from
      // this address" would be a lie: the caller may be refused for someone
      // else's traffic. Only an explicit client-scoped refusal gets the
      // per-address sentence; anything else — including an envelope with no
      // scope at all — gets the neutral one, because guessing wrong here means
      // telling a stranger their own address is over quota when it is not.
      // The neutral copy names no configuration for the same reason the 503
      // below names no vendor (R6.4.3); the operator-facing detail is the
      // warn-once inside rateLimit.js.
      const minutes = Math.ceil(rate.retryAfterSec / 60);
      const detail =
        rate.limitScope === BUCKET_SCOPE.CLIENT
          ? `Too many scans from this address. Try again in ${minutes} minute(s).`
          : `Too many scans right now. Try again in ${minutes} minute(s).`;
      return NextResponse.json(
        { detail },
        {
          status: 429,
          headers: {
            "Retry-After": String(rate.retryAfterSec),
            "X-RateLimit-Limit": String(rate.limit),
            "X-RateLimit-Remaining": String(rate.remaining),
          },
        }
      );
    }

    if (await hasActiveScanForBrand(brand)) {
      return NextResponse.json(
        { detail: "A scan for this brand is already in progress. Please wait for it to finish." },
        { status: 409 }
      );
    }

    // R0.1.21. Checked HERE, not at the top of the handler: validation and the
    // rate limit are free, spend nothing, and must keep their own status codes
    // (a malformed body is still a 400 on a broken deployment). The line that
    // must not be crossed without a database is the next one — creating a job
    // and, three lines later, spending vendor budget on it.
    //
    // `supabase` is the module-level client db.js builds at import time, and
    // `!supabase` is the exact condition createScanJob's memory fallback tests
    // (resolveClient with no injected deps). No client, no persistence, no 201.
    if (!supabase) {
      return scanStoreUnavailable("no database client is configured.");
    }

    // Enqueue the scan job
    const job = await createScanJob({ brand, url, industry, competitors });

    // Belt and braces, in the shape the scan worker route already uses for its
    // own can't-be-true case. The guard above is the one that fires; this one
    // is unreachable while db.js's fallback condition stays `!client`. If that
    // ever diverges — a second fallback path, a client that exists but is
    // inert — the divergence surfaces as a loud 503 with the job id named,
    // instead of quietly restoring the 201 this task exists to remove. It runs
    // BEFORE runScanChunk, so a job that landed in memory costs nothing.
    if (global.memoryJobs instanceof Map && global.memoryJobs.has(job.id)) {
      return scanStoreUnavailable(
        `job ${job.id} was created in memory despite a configured client.`
      );
    }

    // Trigger the first chunk asynchronously (non-blocking). runScanChunk
    // resumes/advances by job id alone — sourcing, probing, and finalize are
    // all driven off the job row + checkpoint, not these function args.
    // R3.1.5: keepAlive registers it with waitUntil so the platform keeps the
    // function alive after the 201 instead of freezing it mid-scan.
    keepAlive(() => runScanChunk(job.id), { label: `[worker-trigger] scan job ${job.id}` });

    return NextResponse.json({
      job_id: job.id,
      status: job.status,
      progress_pct: job.progress_pct
    }, { status: 201 });
  } catch (error) {
    // R0.1.5: the database (migration 007's unique partial index) is now the
    // authority on "one running scan per brand". The pre-flight
    // hasActiveScanForBrand check above is a courtesy that fails open; this is
    // the one that actually holds, and it must surface as 409, not 500.
    if (error instanceof DuplicateScanError || error?.name === "DuplicateScanError") {
      return NextResponse.json(
        { detail: "A scan for this brand is already in progress. Please wait for it to finish." },
        { status: 409 }
      );
    }
    console.error("Scan API POST handler error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
