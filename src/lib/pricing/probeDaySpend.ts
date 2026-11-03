import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Calculates today's committed probe spend in UTC, matching claim_probe_dispatch lines 75-84.
 * Running the three sums read-only.
 */
export async function probeDaySpendToday(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<number> {
  if (!admin || typeof admin.from !== "function") return 0;
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  let total = 0;

  // 1. probe_attempts
  const attemptsRes = await admin
    .from("probe_attempts")
    .select("charged_usd, reserved_usd")
    .gte("started_at", todayUtc);
  if (!attemptsRes.error && Array.isArray(attemptsRes.data)) {
    for (const row of attemptsRes.data) {
      const val = row.charged_usd ?? row.reserved_usd;
      if (val != null && Number.isFinite(Number(val))) {
        total += Number(val);
      }
    }
  }

  // 2. scans without scan_jobs linked to probe_observations
  const scansRes = await admin
    .from("scans")
    .select("id, raw_results")
    .gte("created_at", todayUtc);
  if (!scansRes.error && Array.isArray(scansRes.data) && scansRes.data.length > 0) {
    const scanIds = scansRes.data.map((s: any) => s.id);
    const jobsRes = await admin
      .from("scan_jobs")
      .select("id, result_id, probe_observations!inner(id)")
      .in("result_id", scanIds);
    const coveredResultIds = new Set(
      (jobsRes.data ?? []).map((j: any) => j.result_id),
    );
    for (const scan of scansRes.data) {
      if (!coveredResultIds.has(scan.id)) {
        const cost = scan.raw_results?.cost_total;
        if (cost != null && Number.isFinite(Number(cost))) {
          total += Number(cost);
        }
      }
    }
  }

  // 3. probe_observations with job_id, maximum sourcing_cost per job_id
  const obsRes = await admin
    .from("probe_observations")
    .select("job_id, context")
    .not("job_id", "is", null)
    .gte("created_at", todayUtc);
  if (!obsRes.error && Array.isArray(obsRes.data)) {
    const seedCostsByJob = new Map<string, number>();
    for (const obs of obsRes.data) {
      const jobId = obs.job_id;
      const sourcingCost = obs.context?.sourcing_cost;
      if (sourcingCost != null && Number.isFinite(Number(sourcingCost))) {
        const current = seedCostsByJob.get(jobId) ?? 0;
        seedCostsByJob.set(jobId, Math.max(current, Number(sourcingCost)));
      }
    }
    for (const cost of seedCostsByJob.values()) {
      total += cost;
    }
  }

  return Math.round(total * 1e6) / 1e6;
}
