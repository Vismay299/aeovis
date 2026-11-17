// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/table/nullSafeSort.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { Row } from "@tanstack/react-table";

/**
 * Null/undefined-aware sorting functions that keep blank rows at the bottom
 * regardless of direction. TanStack's built-in `sortUndefined: "last"` gets
 * inverted by the desc sign flip — these helpers read the column's sort
 * direction from the cell context and return a value that survives the flip.
 */

function isDescending<TData>(row: Row<TData>, columnId: string): boolean {
  const cell = row.getAllCells().find((c) => c.column.id === columnId);
  return cell?.column.getIsSorted() === "desc";
}

/**
 * Compare two nullable numeric values with nulls always at the bottom,
 * regardless of the column's current sort direction.
 */
export function compareNumericNullsLast(
  a: number | null | undefined,
  b: number | null | undefined,
  descending: boolean = false,
): number {
  if (a == null && b == null) return 0;
  if (a == null || b == null) {
    const sign = descending ? -1 : 1;
    return (a == null ? 1 : -1) * sign;
  }
  return a - b;
}

export function numericNullsLast<TData>(
  rowA: Row<TData>,
  rowB: Row<TData>,
  columnId: string,
): number {
  return compareNumericNullsLast(
    rowA.getValue<number | null | undefined>(columnId),
    rowB.getValue<number | null | undefined>(columnId),
    isDescending(rowA, columnId),
  );
}
