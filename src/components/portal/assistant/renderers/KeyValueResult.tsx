"use client";

import { formatCellValue, isUntrustedPath, resolveField, type CellFormat } from "./TableResult.tsx";

export type KeyField = {
  key: string;
  label: string;
  format?: CellFormat;
};

/**
 * A definition-list card of named tool values (status rows, measurement
 * summaries). Dotted keys read nested objects. Missing values render as an
 * em dash, never blank.
 */
export function KeyValueResult({
  data,
  fields,
  untrusted = [],
}: {
  data: unknown;
  fields: KeyField[];
  untrusted?: readonly string[];
}) {
  const record =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return (
    <dl className="divide-y divide-border rounded-lg border border-border">
      {fields.map((field) => {
        const value = field.key.includes(".")
          ? field.key
              .split(".")
              .reduce<unknown>(
                (current, segment) =>
                  current !== null && typeof current === "object" && !Array.isArray(current)
                    ? (current as Record<string, unknown>)[segment]
                    : undefined,
                record,
              )
          : resolveField(record, field.key);
        return (
          <div key={field.key} className="flex items-baseline justify-between gap-4 px-3 py-1.5">
            <dt className="shrink-0 text-xs text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 text-right text-xs break-words">
              {formatCellValue(value, field.format, !isUntrustedPath(untrusted, field.key))}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
