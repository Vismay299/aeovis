/**
 * R4.1.1 — Google Search Console persistence: gsc_connections + gsc_daily
 * (migration 018).
 *
 * Every function takes the raw PostgREST envelope seriously: the Supabase
 * client is built without throwOnError, so `{ data: null, error }` is how an
 * outage arrives. Writes and the connection list THROW on error rather than
 * returning [] — an unreadable connection list must not look like "no brand is
 * connected" (standing rule 1).
 */

import { supabase } from "../db.js";

function resolveClient(deps) {
  const client = deps?.client ?? supabase;
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
export async function upsertGscConnection({ brand, siteUrl }, deps = {}) {
  const { data, error } = await resolveClient(deps)
    .from("gsc_connections")
    .upsert({ brand, site_url: siteUrl, enabled: true }, { onConflict: "brand" })
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
  const { error } = await resolveClient(deps).from("gsc_connections").update(patch).eq("brand", brand);
  if (error) throw new Error(`Failed to record GSC attempt for "${brand}": ${error.message}`, { cause: error });
}

/**
 * Upsert daily query rows in chunks. Idempotent on (brand, date, query), which
 * is what makes an overlapping window safe. Returns the number of rows sent;
 * throws on the first failing chunk (earlier chunks stay written, and the next
 * run's overlap re-covers them).
 */
export async function upsertGscDaily(rows, deps = {}) {
  const client = resolveClient(deps);
  let written = 0;
  for (let i = 0; i < rows.length; i += GSC_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + GSC_UPSERT_CHUNK);
    const { error } = await client.from("gsc_daily").upsert(chunk, { onConflict: "brand,date,query" });
    if (error) {
      throw new Error(`Failed to write gsc_daily rows ${i}-${i + chunk.length}: ${error.message}`, { cause: error });
    }
    written += chunk.length;
  }
  return written;
}
