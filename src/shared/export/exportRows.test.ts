// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/exportRows.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { exportRows, type ExportFormat, type ExportDeps } from "./exportRows.ts";

function createMockDeps() {
  const calls = {
    toastError: [] as string[],
    toastSuccess: [] as string[],
    download: [] as { content: string; filename: string; mime: string }[],
    writeText: [] as string[],
    copyTable: [] as { headers: readonly string[]; rows: readonly unknown[][] }[],
    openSheetsModal: [] as number[],
    track: [] as { event: string; props: Record<string, unknown> }[],
  };

  const deps: ExportDeps = {
    toastError(m: string) {
      calls.toastError.push(m);
    },
    toastSuccess(m: string) {
      calls.toastSuccess.push(m);
    },
    download(content: string, filename: string, mime: string) {
      calls.download.push({ content, filename, mime });
    },
    async writeText(text: string) {
      calls.writeText.push(text);
    },
    async copyTable(headers, rows) {
      calls.copyTable.push({ headers, rows });
    },
    openSheetsModal(rowCount: number) {
      calls.openSheetsModal.push(rowCount);
    },
    track(event: string, props: Record<string, unknown>) {
      calls.track.push({ event, props });
    },
  };

  return { calls, deps };
}

const ALL_FORMATS: ExportFormat[] = ["csv", "excel", "json", "copy-json", "sheets"];

for (const format of ALL_FORMATS) {
  test(`exportRows: refuses to export zero rows as ${format}`, async () => {
    const { calls, deps } = createMockDeps();
    await exportRows(
      {
        format,
        feature: "test",
        headers: ["Keyword"],
        rows: [],
        filename: "empty",
      },
      deps,
    );

    assert.deepEqual(calls.toastError, ["No data to export"]);
    assert.equal(calls.download.length, 0);
    assert.equal(calls.writeText.length, 0);
    assert.equal(calls.copyTable.length, 0);
    assert.equal(calls.openSheetsModal.length, 0);
    assert.equal(calls.track.length, 0);
  });
}

test("exportRows: downloads Excel as CSV with UTF-8 BOM, .xls name, and tracks export", async () => {
  const { calls, deps } = createMockDeps();
  await exportRows(
    {
      format: "excel",
      feature: "domain_overview",
      headers: ["Keyword"],
      rows: [["seo audit"]],
      filename: "domain-keywords",
    },
    deps,
  );

  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0].filename, "domain-keywords.xls");
  assert.equal(calls.download[0].mime, "text/csv");
  assert.ok(calls.download[0].content.startsWith("\ufeff"));
  assert.equal(calls.download[0].content.slice(1), '"Keyword"\n"seo audit"');

  assert.deepEqual(calls.track, [
    {
      event: "data:export",
      props: {
        source_feature: "domain_overview",
        format: "excel",
        result_count: 1,
      },
    },
  ]);
});

test("exportRows: downloads CSV with .csv extension and tracks export", async () => {
  const { calls, deps } = createMockDeps();
  await exportRows(
    {
      format: "csv",
      feature: "domain_overview",
      headers: ["Keyword"],
      rows: [["seo audit"]],
      filename: "domain-keywords",
      scope: "selection",
    },
    deps,
  );

  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0].filename, "domain-keywords.csv");
  assert.equal(calls.download[0].content, '"Keyword"\n"seo audit"');

  assert.deepEqual(calls.track, [
    {
      event: "data:export",
      props: {
        source_feature: "domain_overview",
        format: "csv",
        result_count: 1,
        scope: "selection",
      },
    },
  ]);
});

test("exportRows: downloads JSON with .json extension and formatted JSON", async () => {
  const { calls, deps } = createMockDeps();
  await exportRows(
    {
      format: "json",
      feature: "scans",
      headers: ["Id", "Status"],
      rows: [["1", "complete"]],
      filename: "scan-history",
    },
    deps,
  );

  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0].filename, "scan-history.json");
  assert.equal(
    calls.download[0].content,
    JSON.stringify([{ Id: "1", Status: "complete" }], null, 2),
  );
  assert.equal(calls.track[0].event, "data:export");
});

test("exportRows: copy-json copies to clipboard, shows success toast and tracks", async () => {
  const { calls, deps } = createMockDeps();
  await exportRows(
    {
      format: "copy-json",
      feature: "scans",
      headers: ["Id"],
      rows: [["123"]],
      filename: "scan-123",
    },
    deps,
  );

  assert.equal(calls.writeText.length, 1);
  assert.equal(calls.writeText[0], JSON.stringify([{ Id: "123" }], null, 2));
  assert.deepEqual(calls.toastSuccess, ["Copied data"]);
  assert.equal(calls.track.length, 1);
});

test("exportRows: copy-json failure shows error toast and records no event", async () => {
  const { calls, deps } = createMockDeps();
  deps.writeText = async () => {
    throw new Error("clipboard denied");
  };

  await exportRows(
    {
      format: "copy-json",
      feature: "scans",
      headers: ["Id"],
      rows: [["123"]],
      filename: "scan-123",
    },
    deps,
  );

  assert.deepEqual(calls.toastError, ["Could not copy to clipboard"]);
  assert.equal(calls.toastSuccess.length, 0);
  assert.equal(calls.track.length, 0);
});

test("exportRows: sheets path calls copyTable, openSheetsModal, and tracks data:export_sheets", async () => {
  const { calls, deps } = createMockDeps();
  await exportRows(
    {
      format: "sheets",
      feature: "scans",
      headers: ["Date", "Score"],
      rows: [
        ["2026-10-21", 85],
        ["2026-10-22", 90],
      ],
      filename: "scan-history",
    },
    deps,
  );

  assert.equal(calls.copyTable.length, 1);
  assert.deepEqual(calls.openSheetsModal, [2]);
  assert.deepEqual(calls.track, [
    {
      event: "data:export_sheets",
      props: {
        source_feature: "scans",
        result_count: 2,
      },
    },
  ]);
});

test("exportRows: sheets copy failure shows error toast and records no event", async () => {
  const { calls, deps } = createMockDeps();
  deps.copyTable = async () => {
    throw new Error("failed");
  };

  await exportRows(
    {
      format: "sheets",
      feature: "scans",
      headers: ["Date"],
      rows: [["2026-10-21"]],
      filename: "scan-history",
    },
    deps,
  );

  assert.deepEqual(calls.toastError, ["Could not copy to clipboard"]);
  assert.equal(calls.openSheetsModal.length, 0);
  assert.equal(calls.track.length, 0);
});
