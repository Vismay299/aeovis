import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cronAuth";
import { recordCronTick } from "@/lib/db/analytics";
import { supabase } from "@/lib/db";
import { listResumableContentJobs } from "@/lib/db/content";
import { acquireLease, newLeaseOwner } from "@/lib/jobLease";
import { startContentJob } from "@/lib/content/contentWorker";
import { createDailyBatchJobs, getDailyBatchSize } from "@/lib/content/dailyBatch";

// Side-effectful (spends real model budget) — must never run at build time.
export const dynamic = "force-dynamic";

// Mirrors /api/scan/worker: a resumed content job runs a full block pipeline
// and needs the same headroom as the route that first started it (D3).
export const maxDuration = 300;

const MAX_CONCURRENT_RESUMES = 3;

// Boxed so the shared gate can flip it; one warning per process per route.
const warnedNoSecret = { value: false };

/**
 * Cron/worker auth — mirrors /api/scan/worker's isAuthorized exactly (D2).
 *
 * This endpoint resumes content jobs AND, with `?batch=1`, CREATES new ones,
 * each spending real model budget against CONTENT_MAX_COST_PER_ITEM.
 * Unauthenticated it is a free "burn the owner's model budget" button — the
 * scan worker was sealed for precisely this reason (reviewer D4) and this route
 * was left open.
 *
 * When CRON_SECRET is set (production), a caller must present it as
 * `Authorization: Bearer <secret>`, `x-cron-secret: <secret>`, or `?secret=`.
 * The secret is the only credential — the client-settable `x-vercel-cron`
 * header no longer grants access (R0.1.8); Vercel's own cron invocations
 * authenticate with the bearer secret. When CRON_SECRET is unset the gate FAILS CLOSED in
 * production (401) and allows-with-a-warning everywhere else. The
 * implementation is shared with /api/scan/worker in src/lib/cronAuth.js so the
 * two cannot drift.
 */
function isAuthorized(request, searchParams) {
  return isCronAuthorized(request, searchParams, { label: "content-cron", warned: warnedNoSecret });
}

/**
 * Take the lease, then dispatch. Returns the lease owner if we won the job,
 * else null. This is the single-flight gate (D1): before this, the cron fired
 * startContentJob() fire-and-forget with no exclusivity, so two overlapping
 * invocations both ran the same job — two executions racing one row, each
 * spending up to the full per-item cap and each inserting a content_items row.
 */
export async function dispatchWithLease(jobId, label, deps = {}) {
  const acquire = deps.acquireLease ?? acquireLease;
  const start = deps.startContentJob ?? startContentJob;
  const makeOwner = deps.newLeaseOwner ?? newLeaseOwner;

  const owner = makeOwner("cron");
  let won = null;
  try {
    won = await acquire("content_jobs", jobId, owner);
  } catch (err) {
    // Fail CLOSED: if we cannot prove we hold the lease, we must not spend.
    console.error(`[content-cron] lease acquire failed for ${label} ${jobId}:`, err.message);
    return { ok: false, owner: null, reason: "lease_acquire_failed", error: err };
  }
  if (!won) {
    console.log(`[content-cron] ${label} ${jobId} is leased by another worker — skipping`);
    return { ok: false, owner: null, reason: "lease_held", error: null };
  }

  start(jobId, { leaseOwner: owner }).catch((err) => {
    console.error(`[content-cron] Error processing ${label} ${jobId}:`, err);
  });
  return { ok: true, owner, reason: null, error: null };
}

/**
 * The daily batch's brand list, decided from the RAW postgrest envelope.
 *
 * R2.8.5, the same class of read R2.8.4 removed from getScansForBrand. The
 * caller below used to destructure only `data` and drop `error` on the floor.
 * The Supabase client is built without `throwOnError`, so a refused connection,
 * a DNS failure or a 5xx all arrive as `{ data: null, error }` — `rows || []`
 * then made the brand list empty, the per-brand loop never ran, the per-brand
 * catch (and the `batch_failed` counter it feeds, added by R2.8.4) never fired,
 * and the route answered HTTP 200 with a fully green report. A total outage was
 * indistinguishable from "every brand is already up to date": a dead batch that
 * reports itself healthy, which is what standing rule 1 forbids.
 *
 * Unlike ONE brand's failure — kept as degradation at the call site, since one
 * brand must not abort the whole pass — an unreadable brand list means the batch
 * stage did nothing for ANY brand, so it becomes a 5xx (see contentCronReport).
 *
 * Exported because the handler itself cannot be driven in-process with a live
 * client attached: its first act is `recordCronTick`, a WRITE, and the
 * live-write guard (src/lib/liveWriteGuard.js) refuses every write in a test
 * process. This is the real decision, not a copy of it — the handler has no
 * other version of these lines. See src/lib/dbReadOutage.route.test.mjs.
 *
 * @param {{data: Array|null, error: object|null}} envelope postgrest's own reply
 * @returns {{brands: string[], unavailable: {reason: string, detail: string}|null}}
 */
export function brandsForDailyBatch({ data, error } = {}) {
  if (error) {
    return {
      brands: [],
      unavailable: {
        reason: error.code || "db_read_failed",
        detail: "Could not read the brand list — the daily batch did not run for ANY brand.",
      },
    };
  }
  return {
    brands: Array.from(new Set((data || []).map((r) => r && r.brand).filter(Boolean))),
    unavailable: null,
  };
}

/**
 * The cron's report of its own pass, and the status that carries it.
 *
 * R3.1.4 — DISPATCHED, NOT RESUMED / DONE. The content worker sweep fires off
 * content jobs via `dispatchWithLease` (fire-and-forget), the same shape the
 * scan worker sweep uses. Before this fix the report called the dispatched
 * count `resumed` and the skipped-lease count, which collapsed two
 * facts: a job we kicked off and a job we chose not to kick off both rode the
 * same wire as "resumed". Now it follows the scan worker's vocabulary:
 *   - `dispatched` — fire-and-forget jobs we kicked off
 *   - `skipped` — jobs we chose not to kick off (leased by another worker)
 *   - `batch_dispatched` / `batch_dispatched_ids` — daily-batch jobs kicked off
 *   - `batch_failed` — brands where the batch creation itself failed
 *
 * `batch_unavailable` is ALWAYS present so `batch_dispatched: 0` can be read
 * at all: null means the brand list was read and there was nothing to create
 * (a measured zero), an object means it could not be read (never ran). The
 * status is 5xx in the second case — a cron whose batch stage did nothing
 * must not answer 200, or the platform's own failure alerting never sees it.
 *
 * The dispatched counts survive either way: they really did happen, and an
 * operator needs to see which half of the pass worked.
 */
export function contentCronReport({
  startedIds = [],
  skippedIds = [],
  batchCreated = [],
  batchDispatched = batchCreated,
  batchSkipped = [],
  batchFailed = [],
  batchUnavailable = null,
} = {}) {
  const normalizedSkipped = (skippedIds || []).map((s) =>
    typeof s === "string"
      ? { id: s, reason: "lease_held", detail: null }
      : { id: s?.id ?? null, reason: s?.reason ?? "lease_held", detail: s?.detail ?? null }
  );
  const skippedReasons = {};
  for (const s of normalizedSkipped) {
    const r = s.reason || "unknown";
    skippedReasons[r] = (skippedReasons[r] || 0) + 1;
  }

  const normalizedBatchSkipped = (batchSkipped || []).map((s) =>
    typeof s === "string"
      ? { id: s, reason: "lease_held", detail: null }
      : { id: s?.id ?? null, reason: s?.reason ?? "lease_held", detail: s?.detail ?? null }
  );

  return {
    status: batchUnavailable ? 500 : 200,
    body: {
      dispatched: startedIds.length,
      dispatched_ids: startedIds,
      skipped: normalizedSkipped.length,
      skipped_ids: normalizedSkipped.map((s) => s.id).filter(Boolean),
      skips: normalizedSkipped,
      skipped_reasons: skippedReasons,
      batch_dispatched: batchDispatched.length,
      batch_dispatched_ids: batchDispatched,
      batch_skipped: normalizedBatchSkipped.length,
      batch_skipped_ids: normalizedBatchSkipped.map((s) => s.id).filter(Boolean),
      batch_failed: batchFailed.length,
      batch_failed_brands: batchFailed,
      batch_unavailable: batchUnavailable,
    },
  };
}

/**
 * GET /api/content/worker — cron for the content pipeline. Two jobs:
 *   1. Rescue content jobs whose worker died (heartbeat stale + lease free).
 *   2. If CONTENT_DAILY_BATCH>0 and ?batch=1 (daily cadence), enqueue up to
 *      n geo_article jobs from the worst gaps of each brand's latest scan.
 *
 * The batch is gated behind an explicit query param so the frequent resume
 * cron doesn't create jobs every few minutes — a separate daily schedule
 * hits `?batch=1`.
 */
export async function GET(request, contextOrDeps = {}, maybeDeps = {}) {
  const deps =
    maybeDeps && Object.keys(maybeDeps).length > 0
      ? maybeDeps
      : contextOrDeps && !contextOrDeps.params
      ? contextOrDeps
      : {};

  const { searchParams } = new URL(request.url);

  if (!isAuthorized(request, searchParams)) {
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  // R0.1.7: record the tick AFTER the auth gate, so a rejected request never
  // makes a dead cron look alive on /api/health. Non-fatal by design.
  if (deps.recordCronTick) await deps.recordCronTick("content-worker");
  else await recordCronTick("content-worker");

  // R2.8.14: an unconfigured deploy must not answer 200 from a cron that ran
  // nothing — a cron monitor watching status codes would report the system
  // healthy. Reuses the batch_unavailable envelope from R2.8.5 so all
  // fail-quiet DB-read outages share one shape and one reason vocabulary.
  //
  // R3.1.4 — `ledger_written: false` says plainly that no content_runs row was
  // recorded, so an empty ledger can never be mistaken for an idle system.
  if (!supabase) {
    if (!deps.supabase && !deps.client) {
      const { status, body } = contentCronReport({
        batchUnavailable: {
          reason: "db_not_configured",
          detail:
            "The data store is not configured — the content cron cannot resume jobs or create batches.",
        },
      });
      return NextResponse.json({ ...body, ledger_written: false }, { status });
    }
  }

  const client = deps.supabase !== undefined ? deps.supabase : (deps.client !== undefined ? deps.client : supabase);

  try {
    const runBatch = searchParams.get("batch") === "1";

    // 1. Rescue jobs whose worker is presumed dead. A job with a fresh
    //    heartbeat or a live lease is presumed actively worked and skipped.
    const listResumable = deps.listResumableContentJobs ?? listResumableContentJobs;
    const jobs = await listResumable(MAX_CONCURRENT_RESUMES);
    const startedIds = [];
    const skippedIds = [];
    let batchUnavailable = null;
    for (const job of jobs) {
      const res = await dispatchWithLease(job.id, "job", deps);
      if (res.ok) {
        startedIds.push(job.id);
      } else {
        skippedIds.push({
          id: job.id,
          reason: res.reason,
          detail: res.error?.message || null,
        });
        if (res.reason === "lease_acquire_failed" && !batchUnavailable) {
          batchUnavailable = {
            reason: "lease_acquire_failed",
            detail: `Failed to acquire lease for job ${job.id}: ${res.error?.message || "error"}`,
          };
        }
      }
    }

    // 2. Daily batch (opt-in).
    const batchDispatched = [];
    const batchSkipped = [];
    const batchFailed = [];
    const getBatchSize = deps.getDailyBatchSize ?? getDailyBatchSize;
    const batchSize = deps.brands || deps.createDailyBatchJobs ? (getBatchSize() || 5) : getBatchSize();
    if (runBatch && batchSize > 0) {
      const envelope = deps.envelope || (await client
        .from("scans")
        .select("brand")
        .order("scanned_at", { ascending: false })
        .limit(200));

      const { brands, unavailable } = brandsForDailyBatch(envelope);
      const batchBrands = deps.brands || brands;
      batchUnavailable = unavailable || batchUnavailable;
      if (unavailable) {
        console.error(
          "[content-cron] could not read the brand list for the daily batch:",
          envelope.error?.message || envelope.error
        );
      }

      const createDailyBatch = deps.createDailyBatchJobs ?? createDailyBatchJobs;
      for (const brand of batchBrands) {
        try {
          const created = await createDailyBatch(brand);
          for (const job of created) {
            const res = await dispatchWithLease(job.id, "batch job", deps);
            if (res.ok) {
              batchDispatched.push(job.id);
            } else if (res.reason === "lease_held") {
              batchSkipped.push({
                id: job.id,
                reason: res.reason,
                detail: null,
              });
            } else {
              batchFailed.push({
                id: job.id,
                reason: res.reason,
                detail: res.error?.message || null,
              });
              if (!batchUnavailable) {
                batchUnavailable = {
                  reason: "lease_acquire_failed",
                  detail: `Failed to acquire lease for batch job ${job.id}: ${res.error?.message || "error"}`,
                };
              }
            }
          }
        } catch (err) {
          console.warn(`[content-cron] batch for ${brand} failed:`, err.message);
          batchFailed.push({ brand, reason: err.code || err.name || "error" });
        }
      }
    }

    const { status, body } = contentCronReport({
      startedIds,
      skippedIds,
      batchCreated: batchDispatched,
      batchDispatched,
      batchSkipped,
      batchFailed,
      batchUnavailable,
    });
    return NextResponse.json(body, { status });
  } catch (error) {
    console.error("Content cron worker error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
