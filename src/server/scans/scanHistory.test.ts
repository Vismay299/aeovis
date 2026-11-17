// F06 phase 5 — scanHistory schema, query builder and helpers (F06-AC-17, -18).
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCAN_HISTORY_ENGINES,
  buildCollectionFilter,
  derivePhaseTwoRow,
  listScanHistory,
  parseCollectionList,
  parseEngineList,
  scanHistoryQuerySchema,
  zonedDayEndExclusive,
  zonedDayStartUtc,
} from "./scanHistory.ts";

function parse(values: Record<string, string>) {
  return scanHistoryQuerySchema.safeParse(values);
}

test("schema defaults: page 1, size 50, date desc, UTC", () => {
  const parsed = parse({});
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data, {
    page: 1,
    size: 50,
    sort: "date",
    order: "desc",
    tz: "UTC",
  });
});

test("schema accepts a full filter set", () => {
  const parsed = parse({
    page: "2",
    size: "25",
    sort: "visibility",
    order: "asc",
    from: "2026-10-01",
    to: "2026-10-31",
    tz: "Asia/Kolkata",
    startedBy: "scheduled",
    engines: "chatgpt,gemini",
    collection: "complete,partial",
    visMin: "10",
    visMax: "80",
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
});

test("schema refuses every invalid parameter", () => {
  const refusals: Array<[Record<string, string>, string]> = [
    [{ page: "0" }, "page must be >= 1"],
    [{ page: "1.5" }, "page must be an integer"],
    [{ size: "30" }, "size must be 25, 50 or 100"],
    [{ sort: "name" }, "sort must be date or visibility"],
    [{ order: "up" }, "order must be asc or desc"],
    [{ from: "2026-10-31", to: "2026-10-01" }, "from must be <= to"],
    [{ from: "2026-01-01", to: "2027-03-01" }, "span over 400 days"],
    [{ tz: "Not/AZone" }, "unknown time zone"],
    [{ visMin: "80", visMax: "10" }, "visMin must be <= visMax"],
    [{ visMin: "-1" }, "visMin must be 0-100"],
    [{ engines: "claude" }, "unknown engine"],
    [{ engines: "a,b,c,d,e,f,g,h,i,j,k" }, "at most 10 engines"],
    [{ collection: "everything" }, "unknown collection state"],
    [{ extra: "1" }, "unknown field"],
  ];
  for (const [values, message] of refusals) {
    const parsed = parse(values);
    assert.equal(parsed.success, false, `${message} should refuse ${JSON.stringify(values)}`);
  }
});

test("schema accepts all known engine ids", () => {
  const parsed = parse({ engines: SCAN_HISTORY_ENGINES.join(",") });
  assert.equal(parsed.success, true);
});

test("parse helpers trim, de-duplicate and drop empties", () => {
  assert.deepEqual(parseEngineList(" chatgpt, ,gemini,chatgpt "), ["chatgpt", "gemini"]);
  assert.deepEqual(parseEngineList(undefined), []);
  assert.deepEqual(parseCollectionList("complete,pending,complete"), ["complete", "pending"]);
});

test("collection filter is OR inside the group and empty when nothing is selected", () => {
  assert.equal(
    buildCollectionFilter(["pending", "partial", "complete"]),
    "visibility_pct.is.null,collection_partial.eq.true,and(visibility_pct.not.is.null,collection_partial.eq.false)",
  );
  assert.equal(buildCollectionFilter(["complete"]), "and(visibility_pct.not.is.null,collection_partial.eq.false)");
  assert.equal(buildCollectionFilter([]), null);
});

test("zoned day bounds convert Asia/Kolkata wall-clock dates to UTC instants", () => {
  assert.equal(zonedDayStartUtc("2026-10-01", "Asia/Kolkata").toISOString(), "2026-09-30T18:30:00.000Z");
  assert.equal(zonedDayEndExclusive("2026-10-01", "Asia/Kolkata").toISOString(), "2026-10-01T18:30:00.000Z");
  assert.equal(zonedDayStartUtc("2026-10-01", "UTC").toISOString(), "2026-10-01T00:00:00.000Z");
});

test("derivePhaseTwoRow mirrors GET /api/customer/scan for array and object engines", () => {
  const arrayRow = derivePhaseTwoRow({
    id: "s1",
    platform: "multi",
    scanned_at: "2026-10-01T09:00:00.000Z",
    engine_summaries: [
      { engine: "chatgpt", data_source_issue: true },
      { name: "gemini", error_rate_pct: 0 },
    ],
  });
  assert.deepEqual(arrayRow.platform, ["chatgpt", "gemini"]);
  assert.equal(arrayRow.collection_partial, true);

  const objectRow = derivePhaseTwoRow({
    id: "s2",
    platform: "google_ai_overview",
    engine_summaries: { gemini: { error_rate_pct: 12.5 }, chatgpt: {} },
  });
  assert.deepEqual(objectRow.platform, ["gemini", "chatgpt"]);
  assert.equal(objectRow.collection_partial, true);

  const fallbackRow = derivePhaseTwoRow({ id: "s3", platform: "chatgpt", engine_summaries: null });
  assert.equal(fallbackRow.platform, "chatgpt");
  assert.equal(fallbackRow.collection_partial, false);
  assert.equal(fallbackRow.started_by, "manual");
});

/** A PostgREST-shaped recording stub: every call is captured, then resolved. */
class RecordingChain {
  table: string;
  calls: string[] = [];
  rows: Record<string, unknown>[];
  error: unknown;

  constructor(table: string, rows: Record<string, unknown>[] = [], error: unknown = null) {
    this.table = table;
    this.rows = rows;
    this.error = error;
  }

  select(_columns: string, options?: { count?: string }) {
    this.calls.push(`select(${options?.count === "exact" ? "exact" : "rows"})`);
    return this;
  }

  eq(column: string, value: unknown) {
    this.calls.push(`${column}=eq.${value}`);
    return this;
  }

  gte(column: string, value: unknown) {
    this.calls.push(`${column}=gte.${value}`);
    return this;
  }

  lt(column: string, value: unknown) {
    this.calls.push(`${column}=lt.${value}`);
    return this;
  }

  lte(column: string, value: unknown) {
    this.calls.push(`${column}=lte.${value}`);
    return this;
  }

  overlaps(column: string, value: unknown[]) {
    this.calls.push(`${column}=cs.{${value.join(",")}}`);
    return this;
  }

  or(filter: string) {
    this.calls.push(`or=(${filter})`);
    return this;
  }

  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }) {
    this.calls.push(
      `order:${column}.${options.ascending ? "asc" : "desc"}.nulls${options.nullsFirst === false ? "last" : "first"}`,
    );
    return this;
  }

  range(from: number, to: number) {
    this.calls.push(`range:${from}-${to}`);
    return this;
  }

  limit(count: number) {
    this.calls.push(`limit:${count}`);
    return this;
  }

  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
    try {
      resolve({ data: this.rows, error: this.error, count: this.error ? undefined : this.rows.length });
    } catch (error) {
      reject(error);
    }
  }
}

function recordingAdmin(rows: Record<string, unknown>[] = [], error: unknown = null) {
  const chains: RecordingChain[] = [];
  const admin = {
    from(table: string) {
      const chain = new RecordingChain(table, rows, error);
      chains.push(chain);
      return chain;
    },
  };
  return { admin, chains };
}

test("listScanHistory builds one exact-count query with every filter, sort and stable page", async () => {
  const { admin, chains } = recordingAdmin([
    { id: "s1", platform: ["chatgpt"], collection_partial: false, started_by: "scheduled" },
  ]);

  const result = await listScanHistory(admin as never, "acme", {
    page: 2,
    size: 25,
    sort: "visibility",
    order: "asc",
    tz: "UTC",
    startedBy: "scheduled",
    engines: "chatgpt",
    collection: "complete,partial",
    visMin: 10,
    visMax: 80,
  });

  assert.equal(result.totalCount, 1);
  assert.equal(result.page, 2);
  assert.equal(result.size, 25);
  assert.equal(result.scans[0].id, "s1");
  assert.deepEqual(result.scans[0].platform, ["chatgpt"]);
  assert.equal(result.scans[0].started_by, "scheduled");

  assert.deepEqual(chains[0].calls, [
    "select(exact)",
    "brand_key=eq.acme",
    "started_by=eq.scheduled",
    "engines=cs.{chatgpt}",
    "or=(collection_partial.eq.true,and(visibility_pct.not.is.null,collection_partial.eq.false))",
    "visibility_pct=gte.10",
    "visibility_pct=lte.80",
    "order:visibility_pct.asc.nullslast",
    "order:id.asc.nullsfirst",
    "range:25-49",
  ]);
});

test("listScanHistory defaults to the newest first page with no filters", async () => {
  const { admin, chains } = recordingAdmin([]);
  const result = await listScanHistory(admin as never, "acme", {
    page: 1,
    size: 50,
    sort: "date",
    order: "desc",
    tz: "UTC",
  });
  assert.equal(result.totalCount, 0);
  assert.deepEqual(chains[0].calls, [
    "select(exact)",
    "brand_key=eq.acme",
    "order:listed_at.desc.nullslast",
    "order:id.asc.nullsfirst",
    "range:0-49",
  ]);
});

test("listScanHistory converts a zoned date range into listed_at bounds", async () => {
  const { admin, chains } = recordingAdmin([]);
  await listScanHistory(admin as never, "acme", {
    page: 1,
    size: 50,
    sort: "date",
    order: "desc",
    from: "2026-10-01",
    to: "2026-10-02",
    tz: "Asia/Kolkata",
  });
  assert.deepEqual(chains[0].calls, [
    "select(exact)",
    "brand_key=eq.acme",
    "listed_at=gte.2026-09-30T18:30:00.000Z",
    "listed_at=lt.2026-10-02T18:30:00.000Z",
    "order:listed_at.desc.nullslast",
    "order:id.asc.nullsfirst",
    "range:0-49",
  ]);
});
