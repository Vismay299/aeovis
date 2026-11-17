// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/table/tableSelection.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { MouseEvent, MutableRefObject } from "react";
import type { Row, RowSelectionState, Table } from "@tanstack/react-table";

export type SelectionAnchor = {
  id: string;
  selected: boolean;
};

type SelectionRow<T> = Pick<Row<T>, "id" | "getIsSelected" | "getCanSelect">;

type SelectionTable<T> = Pick<Table<T>, "setRowSelection"> & {
  getRowModel: () => {
    rows: SelectionRow<T>[];
  };
};

export function applyShiftRangeSelection<T>(
  event: Pick<MouseEvent<HTMLElement>, "shiftKey" | "preventDefault">,
  row: SelectionRow<T>,
  table: SelectionTable<T>,
  anchorRef: MutableRefObject<SelectionAnchor | null>,
): boolean {
  if (!event.shiftKey || !anchorRef.current) {
    anchorRef.current = {
      id: row.id,
      selected: !row.getIsSelected(),
    };
    return false;
  }

  const rows = table.getRowModel().rows;
  const anchorIndex = rows.findIndex((candidate) => {
    return candidate.id === anchorRef.current?.id;
  });
  const currentIndex = rows.findIndex((candidate) => candidate.id === row.id);

  if (anchorIndex === -1 || currentIndex === -1) {
    anchorRef.current = {
      id: row.id,
      selected: !row.getIsSelected(),
    };
    return false;
  }

  event.preventDefault();

  const [from, to] =
    anchorIndex < currentIndex
      ? [anchorIndex, currentIndex]
      : [currentIndex, anchorIndex];

  const selected = anchorRef.current.selected;
  table.setRowSelection((currentSelection: RowSelectionState) => {
    const nextSelection = { ...currentSelection };

    for (let index = from; index <= to; index++) {
      const rangeRow = rows[index];
      if (!rangeRow?.getCanSelect()) continue;

      if (selected) {
        nextSelection[rangeRow.id] = true;
      } else {
        delete nextSelection[rangeRow.id];
      }
    }

    return nextSelection;
  });
  anchorRef.current = { id: row.id, selected };
  return true;
}
