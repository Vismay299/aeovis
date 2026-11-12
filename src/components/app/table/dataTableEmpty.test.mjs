// F06-AC-01, filtered-empty clause. The Scans history (F06 phase 2) is the
// first DataTable consumer and has no filters, so the clause is covered here
// on the shared component that owns it (owner decision, 2026-11-12).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import * as reactTable from "@tanstack/react-table";
import { compileJsx, renderToHtml, passThroughExports, anyNamedExport, textOf } from "../../../lib/renderHarness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function EmptyStateStub({ kind = "no-data", title, description, action }) {
  return React.createElement("div", { "data-empty-kind": kind },
    React.createElement("h3", null, title),
    description ? React.createElement("p", null, description) : null,
    action ?? null);
}

async function loadDataTable() {
  return compileJsx(path.join(here, "DataTable.tsx"), {
    typescript: true,
    modules: new Map([
      ["react", React],
      ["@tanstack/react-table", reactTable],
      ["@/components/app/EmptyState", { EmptyState: EmptyStateStub }],
      ["@/components/ui/button", { Button: ({ children, onClick }) => React.createElement("button", { type: "button", onClick }, children) }],
      ["@/components/ui/table", passThroughExports],
      ["@/components/ui/checkbox", anyNamedExport],
      ["@/components/ui/skeleton", anyNamedExport],
      ["@/lib/table/tableSelection", await import("../../../lib/table/tableSelection.ts")],
    ]),
  });
}

const columns = [{ id: "name", accessorKey: "name", header: "Name", cell: (c) => c.getValue() }];
const callerEmpty = { title: "No scans yet", description: "Run a scan to see it here." };

function render(DataTable, { data = [], ...props }) {
  function Harness() {
    const table = reactTable.useReactTable({ data, columns, getCoreRowModel: reactTable.getCoreRowModel() });
    return React.createElement(DataTable, { table, empty: callerEmpty, ...props });
  }
  return renderToHtml(Harness);
}

test("no rows with active filters shows the filtered empty state with Clear filters", async () => {
  const { DataTable } = await loadDataTable();
  const html = render(DataTable, { isFiltered: true, onClearFilters: () => {} });
  const text = textOf(html);
  assert.match(html, /data-empty-kind="filtered"/);
  assert.match(text, /No rows match these filters/);
  assert.match(text, /Change or clear the filters to see more rows\./);
  assert.match(html, /<button[^>]*>Clear filters<\/button>/);
  assert.doesNotMatch(text, /No scans yet/, "the caller's empty state is for an unfiltered empty table");
});

test("no rows without filters shows the caller's empty state, not the filtered one", async () => {
  const { DataTable } = await loadDataTable();
  const text = textOf(render(DataTable, { isFiltered: false, onClearFilters: () => {} }));
  assert.match(text, /No scans yet/);
  assert.doesNotMatch(text, /No rows match these filters/);
  assert.doesNotMatch(text, /Clear filters/);
});

test("the filtered empty state offers Clear filters only when the page can clear them", async () => {
  const { DataTable } = await loadDataTable();
  const text = textOf(render(DataTable, { isFiltered: true }));
  assert.match(text, /No rows match these filters/);
  assert.doesNotMatch(text, /Clear filters/);
});

test("rows that match the filters render instead of any empty state", async () => {
  const { DataTable } = await loadDataTable();
  const text = textOf(render(DataTable, { data: [{ name: "acme row" }], isFiltered: true, onClearFilters: () => {} }));
  assert.match(text, /acme row/);
  assert.doesNotMatch(text, /No rows match these filters/);
});
