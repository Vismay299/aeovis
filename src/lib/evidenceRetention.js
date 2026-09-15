/**
 * R1.5.1 — 90-day retention for the `probe-evidence` Storage bucket.
 *
 * Supabase refuses DELETE on storage.objects from SQL (protect_objects_delete),
 * so retention walks the bucket through the Storage API and removes objects
 * older than the cutoff. Driven daily by GET /api/evidence/retention.
 *
 * It reports what it measured: a pass that could not list the bucket throws
 * (never "0 expired"), and a pass that hit its object cap says `truncated`.
 * Budget and layout: docs/runbooks/probe-evidence.md.
 */

import { supabase } from "./db.js";

export const EVIDENCE_BUCKET = "probe-evidence";
export const EVIDENCE_RETENTION_DAYS = 90;
const PAGE = 1000;
const REMOVE_CHUNK = 100;
const DEFAULT_MAX_OBJECTS = 20000;

/** An object's age anchor: created_at, else updated_at. Null when neither parses. */
function objectTimeMs(obj) {
  const t = Date.parse(obj?.created_at || obj?.updated_at || "");
  return Number.isFinite(t) ? t : null;
}

/**
 * Walk the bucket (folders recurse; Storage `list` is one level deep) and
 * return every file object with its full path. Throws on a list error.
 */
export async function listEvidenceObjects(storage, { maxObjects = DEFAULT_MAX_OBJECTS } = {}) {
  const files = [];
  const queue = [""];
  let truncated = false;
  while (queue.length) {
    const prefix = queue.shift();
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await storage.list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`Could not list ${EVIDENCE_BUCKET}/${prefix}: ${error.message}`, { cause: error });
      const page = data || [];
      for (const entry of page) {
        const full = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Storage returns folders as entries with no id and no metadata.
        if (entry.id == null) queue.push(full);
        else files.push({ ...entry, path: full });
        if (files.length >= maxObjects) {
          truncated = true;
          return { files, truncated };
        }
      }
      if (page.length < PAGE) break;
    }
  }
  return { files, truncated };
}

/**
 * Remove objects older than `retentionDays`. Returns measured counts.
 * Objects with no readable timestamp are kept and counted, never deleted.
 */
export async function pruneProbeEvidence(deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const retentionDays = deps.retentionDays ?? EVIDENCE_RETENTION_DAYS;
  const client = deps.client ?? supabase;
  if (!client && !deps.storage) {
    throw new Error("Supabase is not configured — evidence retention did not run. This is not '0 expired'.");
  }
  const storage = deps.storage ?? client.storage.from(EVIDENCE_BUCKET);
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  const { files, truncated } = await listEvidenceObjects(storage, { maxObjects: deps.maxObjects });
  const expired = [];
  let undated = 0;
  let bytesKept = 0;
  for (const f of files) {
    const t = objectTimeMs(f);
    if (t === null) {
      undated += 1;
      continue;
    }
    if (t < cutoffMs) expired.push(f.path);
    else bytesKept += Number(f.metadata?.size) || 0;
  }

  let removed = 0;
  for (let i = 0; i < expired.length; i += REMOVE_CHUNK) {
    const chunk = expired.slice(i, i + REMOVE_CHUNK);
    const { error } = await storage.remove(chunk);
    if (error) {
      throw new Error(
        `Removed ${removed} of ${expired.length} expired evidence objects, then failed: ${error.message}`,
        { cause: error }
      );
    }
    removed += chunk.length;
  }

  return {
    bucket: EVIDENCE_BUCKET,
    retention_days: retentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    scanned: files.length,
    expired: expired.length,
    removed,
    undated_kept: undated,
    bytes_kept: bytesKept,
    truncated,
  };
}
