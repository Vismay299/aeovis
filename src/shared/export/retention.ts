import type { SupabaseClient } from "@supabase/supabase-js";
import { definePeriodic, listPeriodics } from "../../server/jobs/periodic.ts";

export const EXPORT_OBJECT_TTL_MS = 2 * 60 * 60 * 1_000;
export const EXPORT_ROW_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
export const EXPORT_RETENTION_BATCH = 100;
export const EXPORT_RETENTION_LIMIT = 500;

export type ExportRetentionDeps = {
  admin?: SupabaseClient | null;
  now?: () => Date;
};

let boundAdmin: SupabaseClient | null = null;

export function setExportRetentionAdmin(admin: SupabaseClient | null): void {
  boundAdmin = admin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * F06 §6.2 retention: objects of requests older than two hours are removed
 * through the Storage API and their rows marked `deleted`; rows older than 90
 * days are pruned. SQL never deletes objects (`protect_objects_delete`).
 *
 * A failed Storage batch leaves its rows untouched: they stay eligible for the
 * next hourly run, and the failure is logged as a count only (never paths).
 */
export async function runExportRetention(
  deps: ExportRetentionDeps = {},
): Promise<{ removed: number; pruned: number; failedBatches: number }> {
  const admin =
    deps.admin ??
    boundAdmin ??
    (await import("../supabase/admin.js")).getSupabaseAdmin();
  if (!admin) {
    throw new Error("export retention needs a service-role Supabase client");
  }

  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const objectCutoff = new Date(now.getTime() - EXPORT_OBJECT_TTL_MS).toISOString();
  const rowCutoff = new Date(now.getTime() - EXPORT_ROW_TTL_MS).toISOString();

  const { data, error } = await admin
    .from("export_requests")
    .select("id, storage_path")
    .is("deleted_at", null)
    .not("storage_path", "is", null)
    .lt("created_at", objectCutoff)
    .limit(EXPORT_RETENTION_LIMIT);
  if (error) throw error;

  const rows = (Array.isArray(data) ? data : []).filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) && typeof row.id === "string" && typeof row.storage_path === "string",
  );

  let removed = 0;
  let failedBatches = 0;
  for (let offset = 0; offset < rows.length; offset += EXPORT_RETENTION_BATCH) {
    const batch = rows.slice(offset, offset + EXPORT_RETENTION_BATCH);
    const paths = batch.map((row) => row.storage_path as string);
    const { error: removeError } = await admin.storage.from("exports").remove(paths);
    if (removeError) {
      failedBatches += 1;
      console.error(`[exports.retention] storage batch failed rows=${batch.length}`);
      continue;
    }
    const ids = batch.map((row) => row.id as string);
    const { error: updateError } = await admin
      .from("export_requests")
      .update({ status: "deleted", deleted_at: nowIso })
      .in("id", ids);
    if (updateError) {
      failedBatches += 1;
      console.error(`[exports.retention] mark-deleted failed rows=${batch.length}`);
      continue;
    }
    removed += ids.length;
  }

  // Only rows whose object is already gone: pruning a row whose Storage
  // removal keeps failing would forget the path and orphan the object.
  const { data: prunedRows, error: pruneError } = await admin
    .from("export_requests")
    .delete()
    .lt("created_at", rowCutoff)
    .not("deleted_at", "is", null)
    .select("id");
  if (pruneError) throw pruneError;
  const pruned = Array.isArray(prunedRows) ? prunedRows.length : 0;

  console.log(`[exports.retention] removed=${removed} pruned=${pruned}`);
  return { removed, pruned, failedBatches };
}

export function registerExportRetention(deps: ExportRetentionDeps = {}): void {
  if (deps.admin) boundAdmin = deps.admin;
  if (listPeriodics().some((task) => task.name === "exports.retention")) return;
  definePeriodic({
    name: "exports.retention",
    everySeconds: 3_600,
    run: async () => {
      await runExportRetention(deps);
    },
  });
}

// Auto-register on import, exactly like the other feature periodics.
registerExportRetention();
