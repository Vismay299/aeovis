// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/exportRows.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { buildCsv, buildExcelCsv, type CsvValue } from "./csv.ts";

export type ExportFormat = "csv" | "excel" | "json" | "copy-json" | "sheets";

export interface ExportDeps {
  toastError(m: string): void;
  toastSuccess(m: string): void;
  download(content: string, filename: string, mime: string): void;
  writeText(text: string): Promise<void>;
  copyTable(headers: readonly string[], rows: readonly CsvValue[][]): Promise<void>;
  openSheetsModal(rowCount: number): void;
  track(event: string, props: Record<string, unknown>): void;
}

export async function exportRows(
  args: {
    format: ExportFormat;
    feature: string;
    headers: string[];
    rows: CsvValue[][];
    filename: string;
    records?: unknown[];
    scope?: "selection";
  },
  deps: ExportDeps,
): Promise<void> {
  const { format, feature, headers, rows, filename, scope } = args;

  if (rows.length === 0) {
    deps.toastError("No data to export");
    return;
  }

  if (format === "sheets") {
    try {
      await deps.copyTable(headers, rows);
      deps.openSheetsModal(rows.length);
      deps.track("data:export_sheets", {
        source_feature: feature,
        result_count: rows.length,
      });
    } catch {
      deps.toastError("Could not copy to clipboard");
    }
    return;
  }

  const records =
    args.records ??
    rows.map((row) =>
      Object.fromEntries(headers.map((header, i) => [header, row[i]])),
    );

  if (format === "copy-json") {
    try {
      await deps.writeText(JSON.stringify(records, null, 2));
      deps.toastSuccess("Copied data");
    } catch {
      deps.toastError("Could not copy to clipboard");
      return;
    }
  } else if (format === "json") {
    deps.download(
      JSON.stringify(records, null, 2),
      `${filename}.json`,
      "application/json",
    );
  } else if (format === "excel") {
    deps.download(
      buildExcelCsv(headers, rows),
      `${filename}.xls`,
      "text/csv",
    );
  } else {
    deps.download(
      buildCsv(headers, rows),
      `${filename}.csv`,
      "text/csv",
    );
  }

  const props: Record<string, unknown> = {
    source_feature: feature,
    format,
    result_count: rows.length,
  };
  if (scope) {
    props.scope = scope;
  }
  deps.track("data:export", props);
}
