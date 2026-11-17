// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/csv.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Papa from "papaparse";

export type CsvValue = string | number | boolean | null | undefined;

export type ExportValue = string | number | boolean;

export function buildCsv(
  headers: readonly string[],
  rows: readonly CsvValue[][],
): string {
  const normalizedRows = rows.map((row) =>
    row.map((value) => normalizeExportValue(value ?? "")),
  );

  const unparse =
    typeof Papa?.unparse === "function"
      ? Papa.unparse
      : (Papa as unknown as { default?: { unparse: typeof Papa.unparse } })?.default?.unparse ??
        (Papa as unknown as typeof Papa.unparse);

  return unparse(
    {
      fields: [...headers],
      data: normalizedRows,
    },
    {
      quotes: true,
      newline: "\n",
    },
  );
}

export function buildExcelCsv(
  headers: readonly string[],
  rows: readonly CsvValue[][],
): string {
  return "\ufeff" + buildCsv(headers, rows);
}

export function normalizeExportValue(value: CsvValue): ExportValue {
  const normalized =
    typeof value === "number" ? roundExportNumber(value) : value;
  return sanitizeCsvValue(normalized ?? "");
}

function roundExportNumber(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Prevent CSV/TSV injection (formula injection) by prefixing dangerous
// characters with a single quote. See OWASP guidance:
// https://owasp.org/www-community/attacks/CSV_Injection
function sanitizeCsvValue(
  value: string | number | boolean,
): string | number | boolean {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  if (["=", "+", "-", "@", "\t", "\r", "\n"].includes(value[0])) {
    return `'${value}`;
  }

  return value;
}
