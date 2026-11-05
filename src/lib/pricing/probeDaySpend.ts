import type { SupabaseClient } from "@supabase/supabase-js";

// PostgREST caps every response at max_rows (1000 on hosted Supabase), so each read pages until
// a short page comes back. A truncated sum would undercount the day silently.
const PAGE_SIZE = 1000;
// Keeps `.in()` id lists well under the URL length limit.
const ID_CHUNK = 100;

async function readAll(
  page: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: unknown }>,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

/**
 * Calculates today's committed probe spend in UTC, matching claim_probe_dispatch lines 75-84.
 * Running the three sums read-only. Throws when any read fails, so callers never act on a
 * partial sum.
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
  const attempts = await readAll((from, to) =>
    admin
      .from("probe_attempts")
      .select("lease_token, charged_usd, reserved_usd")
      .gte("started_at", todayUtc)
      .order("lease_token")
      .range(from, to),
  );
  for (const row of attempts) {
    const val = row.charged_usd ?? row.reserved_usd;
    if (val != null && Number.isFinite(Number(val))) {
      total += Number(val);
    }
  }

  // 2. scans without scan_jobs linked to probe_observations
  const scans = await readAll((from, to) =>
    admin
      .from("scans")
      .select("id, cost_total:raw_results->cost_total")
      .gte("created_at", todayUtc)
      .order("id")
      .range(from, to),
  );
  const coveredResultIds = new Set<string>();
  for (let i = 0; i < scans.length; i += ID_CHUNK) {
    const ids = scans.slice(i, i + ID_CHUNK).map((s: any) => s.id);
    const jobs = await readAll((from, to) =>
      admin
        .from("scan_jobs")
        .select("id, result_id, probe_observations!inner(id)")
        .in("result_id", ids)
        .order("id")
        .range(from, to),
    );
    for (const j of jobs) coveredResultIds.add(j.result_id);
  }
  for (const scan of scans) {
    if (!coveredResultIds.has(scan.id)) {
      const cost = scan.cost_total;
      if (cost != null && Number.isFinite(Number(cost))) {
        total += Number(cost);
      }
    }
  }

  // 3. probe_observations with job_id, maximum sourcing_cost per job_id
  const observations = await readAll((from, to) =>
    admin
      .from("probe_observations")
      .select("id, job_id, sourcing_cost:context->sourcing_cost")
      .not("job_id", "is", null)
      .gte("created_at", todayUtc)
      .order("id")
      .range(from, to),
  );
  const seedCostsByJob = new Map<string, number>();
  for (const obs of observations) {
    const jobId = obs.job_id;
    const sourcingCost = obs.sourcing_cost;
    if (sourcingCost != null && Number.isFinite(Number(sourcingCost))) {
      const current = seedCostsByJob.get(jobId) ?? 0;
      seedCostsByJob.set(jobId, Math.max(current, Number(sourcingCost)));
    }
  }
  for (const cost of seedCostsByJob.values()) {
    total += cost;
  }

  return Math.round(total * 1e6) / 1e6;
}
