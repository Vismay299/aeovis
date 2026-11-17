"use client";

import { formatUsd } from "@/shared/pricing";
import { formatDate } from "@/components/portal/ui";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type CellFormat = "int" | "usd" | "pct" | "position" | "date" | "url" | "text";

export type TableColumn = {
  key: string;
  label: string;
  format?: CellFormat;
  /** Extra row keys to try when `key` is absent (server field renames). */
  aliases?: string[];
};

/** Resolve a column against a row: exact key, aliases, then a case-insensitive scan. */
export function resolveField(row: Record<string, unknown>, key: string, aliases: string[] = []): unknown {
  if (key in row) return row[key];
  for (const alias of aliases) {
    if (alias in row) return row[alias];
  }
  const lower = key.toLowerCase();
  for (const name of Object.keys(row)) {
    if (name.toLowerCase() === lower) return row[name];
  }
  return undefined;
}

function truncateText(value: string, max = 240): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/**
 * Format one scalar cell. Nullish renders as an em dash, never blank or
 * "null". URL-looking strings render as text, never as live links, when the
 * column's path is listed in the envelope's untrusted paths.
 */
export function formatCellValue(
  value: unknown,
  format: CellFormat = "text",
  link: boolean = true,
): React.ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const scalars = value.filter(
      (item) => item === null || ["string", "number", "boolean"].includes(typeof item),
    );
    if (scalars.length === 0) return "—";
    const shown = scalars.slice(0, 3).map((item) => String(item));
    return truncateText(
      shown.join(", ") + (scalars.length > 3 ? ` +${scalars.length - 3} more` : ""),
    );
  }
  if (typeof value === "object") return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    switch (format) {
      case "usd":
        return formatUsd(value);
      case "pct":
        return value > 1 ? `${Math.round(value)}%` : `${(value * 100).toFixed(1)}%`;
      case "position":
        return value.toFixed(1);
      case "int":
        return Math.round(value).toLocaleString("en-US");
      default:
        return Number.isInteger(value)
          ? value.toLocaleString("en-US")
          : value.toFixed(2);
    }
  }
  const text = String(value);
  if (!text) return "—";
  switch (format) {
    case "date":
      return formatDate(text);
    case "url":
      if (!link) return truncateText(text);
      return (
        <SafeExternalLink url={text} label={truncateText(text)} className="break-all underline underline-offset-2" />
      );
    default:
      return truncateText(text);
  }
}

/** True when `path` (e.g. `items[*].url`) is covered by the envelope's untrusted list. */
export function isUntrustedPath(untrusted: readonly string[], path: string): boolean {
  const flat = (entry: string) => entry.replaceAll("[*]", "");
  const needle = flat(path);
  return untrusted.some((entry) => {
    const base = flat(String(entry));
    return base === needle || needle.startsWith(base + ".") || base.startsWith(needle + ".");
  });
}

/**
 * A capped table of tool rows with humanised column labels. Shows at most 20
 * rows with a "Showing 20 of N" line when the tool reports more. Tables scroll
 * horizontally inside the card on narrow screens.
 */
export function TableResult({
  rows,
  columns,
  totalCount,
  untrusted = [],
  basePath = "",
}: {
  rows: readonly unknown[];
  columns: TableColumn[];
  totalCount?: number | null;
  untrusted?: readonly string[];
  /** Dotted path of the row array inside the envelope (for untrusted checks). */
  basePath?: string;
}) {
  const shown = rows.slice(0, 20);
  const total = typeof totalCount === "number" && Number.isFinite(totalCount) ? totalCount : null;
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.key}>{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row, index) => {
              const record =
                row !== null && typeof row === "object" && !Array.isArray(row)
                  ? (row as Record<string, unknown>)
                  : {};
              return (
                <TableRow key={index}>
                  {columns.map((column) => {
                    const columnPath = basePath ? `${basePath}.${column.key}` : column.key;
                    return (
                      <TableCell key={column.key} className="break-words">
                        {formatCellValue(
                          resolveField(record, column.key, column.aliases),
                          column.format,
                          !isUntrustedPath(untrusted, columnPath),
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {total !== null && total > shown.length ? (
        <p className="text-xs text-muted-foreground">
          Showing {shown.length} of {total.toLocaleString("en-US")}
        </p>
      ) : null}
    </div>
  );
}
