// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityExport.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/errors.ts";
import { serverCsv } from "./serverCsv.ts";
import { getExportKind } from "./kinds/index.ts";

export const EXPORT_URL_TTL_SECONDS = 3_600;
export const EXPORT_RATE_PER_HOUR = 20;
export const EXPORT_MAX_BYTES = 26_214_400;

const NO_ROWS_MESSAGE = "There are no answers in this date range.";
const TOO_LARGE_MESSAGE =
  "This export has more than 50,000 rows. Choose a shorter date range.";
const STORAGE_MESSAGE = "Export storage is unavailable. Please retry.";

type CreateServerExportInput = {
  admin: SupabaseClient;
  brandKey: string;
  userId: string;
  kind: string;
  format: "csv" | "json";
  params: unknown;
  now?: () => Date;
};

type CreateServerExportResult = {
  exportId: string;
  url: string;
  expiresAt: string;
  format: "csv" | "json";
  rowCount: number;
  filename: string;
};

async function markFailed(
  admin: SupabaseClient,
  exportId: string,
  errorCode: string,
): Promise<void> {
  const { error } = await admin
    .from("export_requests")
    .update({ status: "failed", error_code: errorCode })
    .eq("id", exportId);
  if (error) {
    // The customer still gets the original error; the audit row is best effort
    // here so a failed mark cannot replace a useful refusal with a 500.
    console.error(`[exports] failed {exportId: ${exportId}, code: mark_failed}`);
  }
}

/**
 * Build one server-side export (F06 §6.2): rate limit, audit row, kind load,
 * private object, one-hour signed URL. Synchronous by design; the row cap and
 * `maxDuration = 60` on the route keep it inside one function call.
 */
export async function createServerExport(
  input: CreateServerExportInput,
): Promise<CreateServerExportResult> {
  const { admin, brandKey, userId, kind, format } = input;
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const nowIso = startedAt.toISOString();

  const kindDef = getExportKind(kind);
  if (!kindDef) {
    throw new AppError(400, "invalid_request", "Unknown export kind.");
  }

  const parsedParams = kindDef.params.safeParse(input.params);
  if (!parsedParams.success) {
    const message =
      parsedParams.error.issues[0]?.message ?? "The export parameters are not valid.";
    const code = kindDef.kind === "workspace_answers" ? "invalid_range" : "invalid_request";
    throw new AppError(400, code, message);
  }

  const rateCutoff = new Date(startedAt.getTime() - 3_600_000).toISOString();
  const { count, error: rateError } = await admin
    .from("export_requests")
    .select("id", { count: "exact", head: true })
    .eq("brand_key", brandKey)
    .gte("created_at", rateCutoff);
  if (rateError) throw rateError;
  if ((count ?? 0) >= EXPORT_RATE_PER_HOUR) {
    throw new AppError(
      429,
      "export_rate_limited",
      "This workspace has started 20 exports in the last hour. Try again later.",
    );
  }

  const exportId = randomUUID();
  const expiresAt = new Date(startedAt.getTime() + EXPORT_URL_TTL_SECONDS * 1_000).toISOString();
  const { error: insertError } = await admin.from("export_requests").insert({
    id: exportId,
    brand_key: brandKey,
    kind: kindDef.kind,
    format,
    params: parsedParams.data,
    status: "pending",
    created_by: userId,
    created_at: nowIso,
    expires_at: expiresAt,
  });
  if (insertError) throw insertError;

  let loaded: Awaited<ReturnType<typeof kindDef.load>>;
  try {
    loaded = await kindDef.load(admin, brandKey, parsedParams.data);
  } catch (err) {
    const code = err instanceof AppError ? err.code : "internal_error";
    await markFailed(admin, exportId, code);
    throw err;
  }

  if (loaded.rows.length === 0) {
    await markFailed(admin, exportId, "no_rows");
    throw new AppError(422, "no_rows", NO_ROWS_MESSAGE);
  }
  if (loaded.rows.length > kindDef.maxRows) {
    await markFailed(admin, exportId, "export_too_large");
    throw new AppError(413, "export_too_large", TOO_LARGE_MESSAGE);
  }

  const filename = kindDef.filename(brandKey, parsedParams.data, format);
  const body =
    format === "csv"
      ? serverCsv(kindDef.csvHeaders, loaded.rows.map((row) => kindDef.toCsvRow(row)))
      : JSON.stringify(
          kindDef.toJson(loaded.rows, loaded.meta, {
            brandKey,
            exportedAt: nowIso,
          }),
          null,
          2,
        );
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > EXPORT_MAX_BYTES) {
    await markFailed(admin, exportId, "export_too_large");
    throw new AppError(413, "export_too_large", TOO_LARGE_MESSAGE);
  }

  const storagePath = `${brandKey}/${kindDef.kind}/${exportId}.${format}`;
  const { error: uploadError } = await admin.storage.from("exports").upload(storagePath, body, {
    contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json",
    upsert: false,
  });
  if (uploadError) {
    await markFailed(admin, exportId, "storage_unavailable");
    throw new AppError(503, "storage_unavailable", STORAGE_MESSAGE);
  }

  const { data: signed, error: signError } = await admin.storage
    .from("exports")
    .createSignedUrl(storagePath, EXPORT_URL_TTL_SECONDS, { download: filename });
  const url = signed?.signedUrl ?? (signed as { signedURL?: string } | null)?.signedURL;
  if (signError || !url) {
    await markFailed(admin, exportId, "storage_unavailable");
    throw new AppError(503, "storage_unavailable", STORAGE_MESSAGE);
  }

  const { error: readyError } = await admin
    .from("export_requests")
    .update({
      status: "ready",
      row_count: loaded.rows.length,
      byte_size: bytes,
      storage_path: storagePath,
    })
    .eq("id", exportId);
  if (readyError) throw readyError;

  console.log(
    `[exports] ready {exportId: ${exportId}, brandKey: ${brandKey}, kind: ${kindDef.kind}, format: ${format}, rowCount: ${loaded.rows.length}, bytes: ${bytes}}`,
  );

  return {
    exportId,
    url,
    expiresAt,
    format,
    rowCount: loaded.rows.length,
    filename,
  };
}
