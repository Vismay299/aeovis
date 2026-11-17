// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/tableSelection.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import type { MutableRefObject } from "react";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import {
  applyShiftRangeSelection,
  type SelectionAnchor,
} from "./tableSelection.ts";

function makeRow(id: string, selectedIds: Set<string>) {
  return {
    id,
    getIsSelected: () => selectedIds.has(id),
    getCanSelect: () => id !== "locked",
  };
}

function makeEvent(shiftKey: boolean) {
  const event = {
    shiftKey,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };

  return event;
}

function makeTable(ids: string[], selectedIds: Set<string>) {
  return {
    getRowModel: () => ({
      rows: ids.map((id) => makeRow(id, selectedIds)),
    }),
    setRowSelection: (updater: Updater<RowSelectionState>) => {
      const currentSelection = Object.fromEntries(
        Array.from(selectedIds).map((id) => [id, true]),
      );
      const nextSelection =
        typeof updater === "function" ? updater(currentSelection) : updater;

      selectedIds.clear();
      Object.entries(nextSelection).forEach(([id, selected]) => {
        if (selected) selectedIds.add(id);
      });
    },
  };
}

test("applyShiftRangeSelection: selects the visible range from an anchor set by a plain click", () => {
  const selectedIds = new Set<string>();
  const table = makeTable(["a", "b", "c", "d"], selectedIds);
  const anchorRef: MutableRefObject<SelectionAnchor | null> = {
    current: null,
  };

  const plainClick = makeEvent(false);
  assert.equal(
    applyShiftRangeSelection(
      plainClick,
      makeRow("a", selectedIds),
      table,
      anchorRef,
    ),
    false,
  );
  assert.deepEqual(anchorRef.current, { id: "a", selected: true });
  assert.equal(plainClick.defaultPrevented, false);
  selectedIds.add("a");

  const event = makeEvent(true);
  assert.equal(
    applyShiftRangeSelection(
      event,
      makeRow("c", selectedIds),
      table,
      anchorRef,
    ),
    true,
  );
  assert.deepEqual(Array.from(selectedIds), ["a", "b", "c"]);
  assert.deepEqual(anchorRef.current, { id: "c", selected: true });
  assert.equal(event.defaultPrevented, true);
});

test("applyShiftRangeSelection: clears the visible range from a deselected anchor", () => {
  const selectedIds = new Set<string>(["a", "b", "c", "d"]);
  const table = makeTable(["a", "b", "c", "d"], selectedIds);
  const anchorRef: MutableRefObject<SelectionAnchor | null> = {
    current: { id: "b", selected: false },
  };

  applyShiftRangeSelection(
    makeEvent(true),
    makeRow("d", selectedIds),
    table,
    anchorRef,
  );

  assert.deepEqual(Array.from(selectedIds), ["a"]);
  assert.deepEqual(anchorRef.current, { id: "d", selected: false });
});

test("applyShiftRangeSelection: skips rows that can't be selected", () => {
  const selectedIds = new Set<string>();
  const table = makeTable(["a", "locked", "c"], selectedIds);
  const anchorRef: MutableRefObject<SelectionAnchor | null> = {
    current: { id: "a", selected: true },
  };

  applyShiftRangeSelection(
    makeEvent(true),
    makeRow("c", selectedIds),
    table,
    anchorRef,
  );

  assert.deepEqual(Array.from(selectedIds), ["a", "c"]);
});
