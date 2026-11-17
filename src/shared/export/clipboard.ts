// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/clipboard.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { normalizeExportValue, type CsvValue, type ExportValue } from "./csv.ts";
import { safeHttpUrl } from "../safe-url.ts";

export const GOOGLE_SHEETS_NEW_URL = "https://sheets.new";

export interface ClipboardDeps {
  clipboard?: {
    write(items: any[]): Promise<void>;
  };
  ClipboardItem?: {
    new (...args: any[]): any;
  };
}

export async function copyTableToClipboard(
  headers: readonly string[],
  rows: readonly CsvValue[][],
  deps?: ClipboardDeps,
): Promise<void> {
  const clipboard =
    deps?.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  const ItemCtor =
    deps?.ClipboardItem ??
    (typeof ClipboardItem !== "undefined" ? ClipboardItem : undefined);

  if (!clipboard?.write || !ItemCtor) {
    throw new Error("Clipboard API not available in this browser.");
  }

  const safeRows = rows.map((row) =>
    row.map((value) => normalizeExportValue(value ?? "")),
  );

  const tsv = buildTsv(headers, safeRows);
  const html = buildHtmlTable(headers, safeRows);

  // Wrap blobs in Promise.resolve for Safari <17.4 compatibility — older
  // Safari requires Promise<Blob> values; modern browsers accept either.
  await clipboard.write([
    new ItemCtor({
      "text/plain": Promise.resolve(new Blob([tsv], { type: "text/plain" })),
      "text/html": Promise.resolve(new Blob([html], { type: "text/html" })),
    }),
  ]);
}

export function buildTsv(
  headers: readonly string[],
  rows: readonly ExportValue[][],
): string {
  const lines = [headers.map(tsvCell).join("\t")];
  for (const row of rows) {
    lines.push(row.map(tsvCell).join("\t"));
  }
  return lines.join("\n");
}

function tsvCell(value: ExportValue): string {
  if (typeof value !== "string") return String(value);
  return value.replace(/[\t\r\n]+/g, " ");
}

export function buildHtmlTable(
  headers: readonly string[],
  rows: readonly ExportValue[][],
): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtmlCell(cell)}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function escapeHtmlCell(value: ExportValue): string {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (safeHttpUrl(value)) {
    const safeValue = escapeHtml(value);
    return `<a href="${escapeHtml(value)}">${safeValue}</a>`;
  }
  return escapeHtml(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
