// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useExportRows } from "@/components/app/export/useExportRows";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { describeError } from "@/shared/query/errors";
import {
  SAVED_KEYWORD_EXPORT_HEADERS,
  formatCentsForCsv,
  savedKeywordExportRow,
  type SavedKeywordRow,
} from "@/shared/keywords";

export type SavedKeywordsExportFormat = "sheets" | "csv";

export type SavedKeywordsExportResponse = {
  rows: SavedKeywordRow[];
  totalCount: number;
  truncated: boolean;
};

/**
 * Exports the selected rows from memory, or the whole filtered list from
 * `GET /saved/export` (which is not paged).
 */
export function useSavedKeywordsExport({
  brandKey,
  exportQuery,
}: {
  brandKey: string;
  exportQuery: Record<string, string | number>;
}) {
  const runExportRows = useExportRows();
  const [busy, setBusy] = useState(false);

  const exportRows = async (
    format: SavedKeywordsExportFormat,
    rows: SavedKeywordRow[],
  ) => {
    const csvRows = rows.map(savedKeywordExportRow);
    await runExportRows({
      format,
      feature: "keywords",
      headers: SAVED_KEYWORD_EXPORT_HEADERS,
      rows: format === "csv" ? formatCentsForCsv(csvRows) : csvRows,
      filename: "saved-keywords",
      records: rows,
    });
  };

  const exportSelected = async (
    format: SavedKeywordsExportFormat,
    rows: SavedKeywordRow[],
  ) => {
    setBusy(true);
    try {
      await exportRows(format, rows);
    } finally {
      setBusy(false);
    }
  };

  const exportFiltered = async (format: SavedKeywordsExportFormat) => {
    setBusy(true);
    try {
      const data = await fetchJson<SavedKeywordsExportResponse>(
        withBrand("/api/customer/keywords/saved/export", brandKey, exportQuery),
      );
      await exportRows(format, data.rows ?? []);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return { busy, exportSelected, exportFiltered };
}
