import { fetchDailyQueryRowsForBrand } from "../../shared/engines/gsc.js";
import { ingestWindow, toDailyRows } from "./ingest.js";
import { makeSelfContinue } from "../selfContinue.js";

export const wakeGscWorker = makeSelfContinue({ routePath: "/api/gsc/sync-worker", label: "gsc-sync" });

/** One bounded page per claimed job; SQL commits rows and progress together. */
export async function processGscSyncJob(job, connection, { admin, workerId, fetchRows = fetchDailyQueryRowsForBrand, now = () => new Date() }) {
  let startDate = job.window_start_date;
  let endDate = job.window_end_date;
  if (!startDate || !endDate) {
    const window = ingestWindow(connection, now());
    if (!window) throw new Error("Invalid Search Console sync window.");
    ({ startDate, endDate } = window);
    const { data, error } = await admin.from("gsc_sync_jobs")
      .update({ window_start_date: startDate, window_end_date: endDate })
      .eq("id", job.id).eq("status", "running").eq("lease_owner", workerId)
      .select("id").maybeSingle();
    if (error || !data) throw new Error("Sync lease is no longer active.");
  }
  const { rows, truncated, nextStartRow } = await fetchRows(connection.site_url, {
    startDate, endDate, startRow: job.checkpoint_page || 0, pageSize: 5000, maxPages: 1,
  }, { brandKey: connection.brand_key, admin, authMode: connection.auth_mode });
  if (truncated && (!Number.isInteger(nextStartRow) || nextStartRow <= (job.checkpoint_page || 0))) {
    throw new Error("Google pagination did not advance.");
  }
  const mapped = toDailyRows(connection.brand, connection.site_url, rows, now().toISOString(), connection.connection_generation, connection.brand_key);
  const { data, error } = await admin.rpc("commit_customer_gsc_page", {
    p_job_id: job.id, p_worker: workerId, p_rows: mapped,
    p_next_page: truncated ? nextStartRow : job.checkpoint_page || 0, p_complete: !truncated,
  });
  if (error) throw new Error("Could not commit Search Console sync progress.");
  return { status: truncated ? "pending" : "completed", rows_written: data, truncated };
}
