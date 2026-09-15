import {
  runScanChunk,
  shouldRescueJob,
} from "@/lib/workers/scanWorker";

const MAX_CONCURRENT_RESUMES = 3;

/**
 * R6.5.8 — The sweep branch of GET /api/scan/worker, extracted into a _lib
 * module so the supabase client is an injectable parameter rather than a
 * module-level import binding.
 *
 * The original route imported `supabase` from `@/lib/db` and used it directly
 * at the module scope. That binding has no seam: a test that clears env vars
 * to null the client can never enter the sweep branch, and a test that needs
 * the branch to execute cannot replace the binding. This module accepts the
 * client as its first argument, following the scanRow.js precedent in
 * src/app/api/scans/_lib/.
 *
 * The route's GET handler calls `executeSweep(supabase)` — unchanged
 * behaviour for production. Tests call it with a fake client that returns
 * canned data, so the sweep branch is reachable end-to-end without a real
 * database.
 *
 * The `runSweepMaintenance` and `buildSweepResponse` functions live in
 * route.js (they are tested there and imported by the test suite). This
 * module does NOT import from route.js to avoid a circular dependency; the
 * caller passes them. The route passes the real implementations. Tests pass
 * fakes or the reals, as they choose.
 *
 * @param {object|null} supabaseClient - the Supabase client (or a fake)
 * @param {object} [deps]
 * @param {Function} [deps.shouldRescueJob] - predicate for stale jobs
 * @param {Function} [deps.runScanChunk] - fire-and-forget chunk resume
 * @param {Function} [deps.runSweepMaintenance] - scheduler tick + reap
 * @param {Function} [deps.buildSweepResponse] - wire body builder
 * @returns {Promise<object>} the response body for the sweep
 */
export async function executeSweep(supabaseClient, deps = {}) {
  const rescueJob = deps.shouldRescueJob || shouldRescueJob;
  const scanChunk = deps.runScanChunk || runScanChunk;
  const maintenanceFn = deps.runSweepMaintenance;
  const buildResponse = deps.buildSweepResponse;

  if (typeof maintenanceFn !== "function" || typeof buildResponse !== "function") {
    throw new Error(
      "executeSweep requires deps.runSweepMaintenance and deps.buildSweepResponse — " +
        "this module does not import them from route.js to avoid a circular dependency."
    );
  }

  const { data: activeJobs, error } = await supabaseClient
    .from("scan_jobs")
    .select("*")
    .not("status", "in", '("complete","failed")')
    .limit(20);

  if (error) {
    throw error;
  }

  const toResume = (activeJobs || [])
    .filter((job) => rescueJob(job))
    .slice(0, MAX_CONCURRENT_RESUMES);

  const resumedIds = [];
  for (const job of toResume) {
    scanChunk(job.id).catch((err) => {
      console.error(`[cron-worker] Error resuming job ${job.id}:`, err);
    });
    resumedIds.push(job.id);
  }

  const { scheduled, scheduler, reaped } = await maintenanceFn(
    new Date().toISOString()
  );

  return buildResponse({
    activeCount: (activeJobs || []).length,
    resumedIds,
    scheduled,
    scheduler,
    reaped,
  });
}
