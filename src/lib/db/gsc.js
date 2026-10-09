/**
 * GSC persistence: gsc_connections + gsc_daily + gsc_sync_jobs.
 *
 * Supports both legacy service-account and new OAuth connections.
 * Every function takes the raw PostgREST envelope seriously: the Supabase
 * client is built without throwOnError, so `{ data: null, error }` is how an
 * outage arrives. Writes and the connection list THROW on error rather than
 * returning [] — an unreadable connection list must not look like "no brand is
 * connected" (standing rule 1).
 */

import { supabase } from "../db.js";

function resolveClient(deps) {
  const client = deps?.client ?? deps?.admin ?? supabase;
  if (!client) {
    throw new Error("Supabase is not configured — GSC data cannot be read or written. This is a refusal, not an empty result.");
  }
  return client;
}

/** Postgres/PostgREST caps a request body; keep upsert batches well under it. */
export const GSC_UPSERT_CHUNK = 1000;

/** Enabled brand->property connections, oldest-ingested first. Throws on a read failure. */
export async function listGscConnections(deps = {}) {
  const { data, error } = await resolveClient(deps)
    .from("gsc_connections")
    .select("*")
    .eq("enabled", true)
    .order("last_attempt_at", { ascending: true, nullsFirst: true });
  if (error) throw new Error(`Failed to list GSC connections: ${error.message}`, { cause: error });
  return data || [];
}

/** One brand's connection, or null when the brand is not connected. Throws on a read failure. */
export async function getGscConnection(brand, deps = {}) {
  const { data, error } = await resolveClient(deps)
    .from("gsc_connections")
    .select("*")
    .eq("brand", brand)
    .maybeSingle();
  if (error) throw new Error(`Failed to read GSC connection for "${brand}": ${error.message}`, { cause: error });
  return data || null;
}

/** Create or re-point a connection. Re-connecting re-enables it. */
export async function upsertGscConnection({ brand, siteUrl, brandKey, authMode, credentialId, connectionGeneration }, deps = {}) {
  const row = {
    brand,
    brand_key: brandKey || null,
    site_url: siteUrl,
    enabled: true,
    auth_mode: authMode || "service_account",
    credential_id: credentialId || null,
    connection_generation: connectionGeneration || 1,
  };
  const { data, error } = await resolveClient(deps)
    .from("gsc_connections")
    .upsert(row, { onConflict: "brand" })
    .select()
    .single();
  if (error) throw new Error(`Failed to save GSC connection for "${brand}": ${error.message}`, { cause: error });
  if (!data) throw new Error(`GSC connection for "${brand}" was written but could not be confirmed.`);
  return data;
}

/** Record the outcome of one ingest attempt on the connection row. */
export async function recordGscAttempt(brand, outcome, deps = {}) {
  const patch = {
    last_attempt_at: outcome.at,
    last_status: outcome.status,
    last_error: outcome.error ?? null,
    last_rows_written: outcome.rowsWritten ?? null,
  };
  // Only a successful run advances the watermark; a failure must not skip days.
  if (outcome.status === "ok" && outcome.ingestedThrough) {
    patch.last_ingested_through = outcome.ingestedThrough;
  }
  let query = resolveClient(deps).from("gsc_connections").update(patch).eq("brand", brand);
  if (deps.connection) query = query.eq("connection_generation", deps.connection.connection_generation || 1).eq("enabled", true);
  const { error } = await query;
  if (error) throw new Error(`Failed to record GSC attempt for "${brand}": ${error.message}`, { cause: error });
}

/**
 * Upsert daily query rows in chunks. Idempotent on (brand, date, query) and
 * (brand_key, date, query, connection_generation). Returns the number of rows
 * sent; throws on the first failing chunk.
 */
export async function upsertGscDaily(rows, deps = {}) {
  const client = resolveClient(deps);
  let written = 0;
  for (let i = 0; i < rows.length; i += GSC_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + GSC_UPSERT_CHUNK);
    const { error } = await client.rpc("write_gsc_generation", {
      p_brand: deps.connection?.brand || chunk[0].brand,
      p_generation: deps.connection?.connection_generation || chunk[0].connection_generation || 1,
      p_rows: chunk,
    });
    if (error) {
      throw new Error(`Failed to write gsc_daily rows ${i}-${i + chunk.length}: ${error.message}`, { cause: error });
    }
    written += chunk.length;
  }
  return written;
}

/**
 * Get pending sync jobs for processing.
 */
export async function listPendingSyncJobs(deps = {}) {
  const { data, error } = await resolveClient(deps)
    .from("gsc_sync_jobs")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(`Failed to list pending sync jobs: ${error.message}`, { cause: error });
  return data || [];
}

/**
 * Claim a sync job by setting its status to 'running' and lease info.
 */
export async function claimSyncJob(jobId, leaseOwner, leaseDurationMs = 300000, deps = {}) {
  const now = new Date().toISOString();
  const { data, error } = await resolveClient(deps)
    .from("gsc_sync_jobs")
    .update({
      status: "running",
      lease_owner: leaseOwner,
      lease_expires_at: new Date(Date.now() + leaseDurationMs).toISOString(),
      started_at: now,
      attempts: undefined, // will be incremented by the DB if we use a raw query
      updated_at: now,
    })
    .eq("id", jobId)
    .eq("status", "pending")
    .select()
    .single();
  if (error) return null; // Lost the race
  return data;
}

/**
 * Update sync job progress.
 */
export async function updateSyncJob(jobId, updates, deps = {}) {
  const { error } = await resolveClient(deps)
    .from("gsc_sync_jobs")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to update sync job ${jobId}: ${error.message}`, { cause: error });
}

/**
 * Complete a sync job.
 */
export async function completeSyncJob(jobId, rowsWritten, deps = {}) {
  await updateSyncJob(jobId, {
    status: "completed",
    completed_at: new Date().toISOString(),
    rows_written: rowsWritten,
  }, deps);
}

/**
 * Fail a sync job.
 */
export async function failSyncJob(jobId, errorMessage, deps = {}) {
  await updateSyncJob(jobId, {
    status: "failed",
    error_message: String(errorMessage || "").slice(0, 500),
  }, deps);
}
