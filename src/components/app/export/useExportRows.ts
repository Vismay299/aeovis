"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/exportRows.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback } from "react";
import { toast } from "sonner";
import { downloadFile } from "@/lib/export/download";
import { copyTableToClipboard } from "@/lib/export/clipboard";
import { openSheetsModal } from "@/lib/export/sheetsModalStore";
import {
  exportRows,
  type ExportFormat,
  type ExportDeps,
} from "@/lib/export/exportRows";
import { trackExport } from "@/lib/export/telemetry";
import type { CsvValue } from "@/lib/export/csv";

export async function copyList(items: string[], label: string): Promise<void> {
  if (items.length === 0) {
    toast.error("No data to export");
    return;
  }
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("Clipboard API unavailable");
    }
    await navigator.clipboard.writeText(items.join("\n"));
    toast.success(`Copied ${label}`);
  } catch {
    toast.error("Could not copy to clipboard");
  }
}

export function useExportRows() {
  return useCallback(
    async (args: {
      format: ExportFormat;
      feature: string;
      headers: string[];
      rows: CsvValue[][];
      filename: string;
      records?: unknown[];
      scope?: "selection";
    }) => {
      const deps: ExportDeps = {
        toastError: (m) => toast.error(m),
        toastSuccess: (m) => toast.success(m),
        download: (content, filename, mime) =>
          downloadFile(content, filename, mime),
        writeText: async (text) => {
          if (
            typeof navigator === "undefined" ||
            !navigator.clipboard?.writeText
          ) {
            throw new Error("Clipboard API unavailable");
          }
          await navigator.clipboard.writeText(text);
        },
        copyTable: async (headers, rows) => {
          await copyTableToClipboard(headers, rows);
        },
        openSheetsModal: (rowCount) => {
          openSheetsModal(rowCount);
        },
        track: (event, props) => {
          trackExport(event, props);
        },
      };

      await exportRows(args, deps);
    },
    [],
  );
}
