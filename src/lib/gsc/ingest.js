/**
 * GSC data ingest — supports both service-account and OAuth auth modes.
 *
 * For every enabled gsc_connections row: pull per-day, per-query Search
 * Analytics rows for a window, upsert them into gsc_daily, and record the
 * outcome on the connection. Driven by the GSC sync worker.
 *
 * WINDOW. GSC data lags about two days and late days keep settling, so the
 * window always ends LAG_DAYS ago and re-reads OVERLAP_DAYS behind the last
 * successful watermark. Upserts are keyed (brand_key, date, query,
 * connection_generation), so re-reading is free of duplicates.
 *
 * FAILURE. One brand's failure never aborts the others, and is recorded on its
 * own row with last_status='failed'. A failure does NOT advance the watermark,
 * so the next run re-covers the missed days.
 */

import { fetchDailyQueryRows, fetchDailyQueryRowsForBrand } from "../engines/gsc.js";
import { listGscConnections, recordGscAttempt, upsertGscDaily } from "../db/gsc.js";
import { getSupabaseAdmin } from "../supabase/admin.js";

export const LAG_DAYS = 2;
export const OVERLAP_DAYS = 7;
export const BACKFILL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const fmt = (d) => d.toISOString().slice(0, 10);

/**
 * The inclusive [startDate, endDate] to pull for a connection, or null when
 * there is nothing new to read (the watermark already reaches the end date).
 */
export function ingestWindow(connection, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - LAG_DAYS * DAY_MS);
  const through = connection?.last_ingested_through;
  let start;
  if (through && /^\d{4}-\d{2}-\d{2}$/.test(through)) {
    start = new Date(Date.parse(`${through}T00:00:00Z`) - (OVERLAP_DAYS - 1) * DAY_MS);
  } else {
    start = new Date(end.getTime() - (BACKFILL_DAYS - 1) * DAY_MS);
  }
  if (start > end) return null;
  return { startDate: fmt(start), endDate: fmt(end) };
}

/** Map API rows to gsc_daily rows. Rows without a date or query are dropped, not coerced. */
export function toDailyRows(brand, siteUrl, apiRows, ingestedAt, connectionGeneration = 1, brandKey = null) {
  const out = [];
  for (const r of apiRows || []) {
    if (!r?.date || !r?.query) continue;
    out.push({
      brand,
      brand_key: brandKey,
      site_url: siteUrl,
      date: r.date,
      query: r.query,
      clicks: Math.max(0, Math.round(Number(r.clicks) || 0)),
      impressions: Math.max(0, Math.round(Number(r.impressions) || 0)),
      ctr: Number(r.ctr) || 0,
      position: Number(r.position) || 0,
      ingested_at: ingestedAt,
      connection_generation: connectionGeneration || 1,
    });
  }
  return out;
}

/** Ingest one connection. Never throws for a GSC/DB failure; returns the outcome. */
export async function ingestConnection(connection, deps = {}) {
  deps = { ...deps, connection };
  const now = deps.now ? deps.now() : new Date();
  const at = now.toISOString();
  const upsert = deps.upsertGscDaily ?? upsertGscDaily;
  const record = deps.recordGscAttempt ?? recordGscAttempt;
  const { brand, brand_key: brandKey, site_url: siteUrl, auth_mode: authMode, connection_generation: connGen } = connection;
  const brandIdentifier = brand;

  // Choose the appropriate fetch function based on auth mode.
  const fetchRows = authMode === "oauth" && deps.admin
    ? (siteUrl, opts) => fetchDailyQueryRowsForBrand(siteUrl, opts, { brandKey, admin: deps.admin, authMode: "oauth" })
    : (deps.fetchDailyQueryRows ?? fetchDailyQueryRows);

  const window = ingestWindow(connection, now);
  let outcome;
  if (!window) {
    outcome = { brand: brandIdentifier, status: "ok", rowsWritten: 0, window: null, truncated: false, at, error: null,
      ingestedThrough: connection.last_ingested_through ?? null };
  } else {
    try {
      if (authMode === "oauth" && !deps.admin) throw new Error("OAuth credentials are unavailable for this workspace.");
      const { rows, truncated } = await fetchRows(siteUrl, window);
      const dailyRows = toDailyRows(brandIdentifier, siteUrl, rows, at, connGen, brandKey);
      const rowsWritten = dailyRows.length ? await upsert(dailyRows, deps) : 0;
      outcome = {
        brand: brandIdentifier, status: "ok", rowsWritten, window, truncated, at, error: null,
        // A truncated pull did not read the whole window; do not claim it did.
        ingestedThrough: truncated ? connection.last_ingested_through ?? null : window.endDate,
      };
    } catch (err) {
      outcome = { brand: brandIdentifier, status: "failed", rowsWritten: 0, window, truncated: false, at,
        error: String(err?.message || err).slice(0, 500), ingestedThrough: null };
    }
  }

  try {
    await record(brand, outcome, deps);
    outcome.recorded = true;
  } catch (err) {
    // The rows (if any) are written; only the bookkeeping failed. Say so.
    outcome.recorded = false;
    outcome.recordError = String(err?.message || err).slice(0, 500);
  }
  return outcome;
}

/**
 * Ingest every enabled connection. Throws only when the connection list itself
 * cannot be read — that is "ran for nobody", not "nobody is connected".
 */
export async function runGscIngest(deps = {}) {
  deps = { ...deps, admin: deps.admin ?? getSupabaseAdmin() };
  const list = deps.listGscConnections ?? listGscConnections;
  const connections = await list(deps);
  const results = [];
  for (const connection of connections) {
    if (connection.auth_mode === "oauth" || deps.excludeBrands?.has(connection.brand)) continue;
    results.push(await ingestConnection(connection, deps));
  }
  return {
    connections: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "failed").length,
    rows_written: results.reduce((n, r) => n + r.rowsWritten, 0),
    results,
  };
}
