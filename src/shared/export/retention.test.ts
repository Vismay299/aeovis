import test from "node:test";
import assert from "node:assert/strict";
import { runExportRetention } from "./retention.ts";

const NOW = new Date("2026-10-21T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function makeAdmin(rows: any[], failRemoveOn: number | null = null) {
  const state = { rows, removeCalls: 0, removals: [] as string[][] };
  const query: any = {
    mode: null,
    filters: [] as Array<[string, string]>,
    ids: null as string[] | null,
    patch: null as Record<string, unknown> | null,
    select() {
      if (!query.mode) query.mode = "select";
      return query;
    },
    is() {
      return query;
    },
    not() {
      return query;
    },
    lt(column: string, value: string) {
      query.filters.push([column, value]);
      return query;
    },
    limit() {
      return query;
    },
    update(patch: Record<string, unknown>) {
      query.mode = "update";
      query.patch = patch;
      query.filters = [];
      return query;
    },
    in(_column: string, ids: string[]) {
      query.ids = ids;
      return query;
    },
    delete() {
      query.mode = "delete";
      query.filters = [];
      return query;
    },
    then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
      try {
        resolve(query.run());
      } catch (error) {
        reject(error);
      }
    },
    run() {
      if (query.mode === "select") {
        const cutoff = query.filters.find(([column]: [string, string]) => column === "created_at")?.[1];
        const found = state.rows.filter((row: any) => row.deleted_at == null && row.storage_path && row.created_at < cutoff);
        return { data: found.slice(0, 500), error: null };
      }
      if (query.mode === "update") {
        for (const row of state.rows) {
          if (query.ids?.includes(row.id)) Object.assign(row, query.patch);
        }
        return { data: null, error: null };
      }
      const cutoff = query.filters.find(([column]: [string, string]) => column === "created_at")?.[1];
      const removed = state.rows.filter((row: any) => row.created_at < cutoff);
      state.rows = state.rows.filter((row: any) => row.created_at >= cutoff);
      return { data: removed.map((row: any) => ({ id: row.id })), error: null };
    },
  };

  const admin: any = {
    state,
    from(table: string) {
      assert.equal(table, "export_requests");
      return {
        select: () => query.select(),
        update: (patch: Record<string, unknown>) => query.update(patch),
        delete: () => query.delete(),
      };
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "exports");
        return {
          remove: async (paths: string[]) => {
            state.removeCalls += 1;
            state.removals.push(paths);
            if (failRemoveOn !== null && state.removeCalls === failRemoveOn) {
              return { data: null, error: { message: "storage down" } };
            }
            return { data: paths.map((path) => ({ name: path })), error: null };
          },
        };
      },
    },
  };
  return admin;
}

test("retention removes objects older than 2h, marks them deleted, then prunes rows older than 90 days", async () => {
  const rows = [
    {
      id: "three-hours",
      storage_path: "acme/workspace_answers/three-hours.csv",
      status: "ready",
      created_at: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
      deleted_at: null,
    },
    {
      id: "one-hour",
      storage_path: "acme/workspace_answers/one-hour.csv",
      status: "ready",
      created_at: new Date(NOW.getTime() - 1 * HOUR).toISOString(),
      deleted_at: null,
    },
    {
      id: "ninety-one-days",
      storage_path: "acme/workspace_answers/ninety-one-days.csv",
      status: "ready",
      created_at: new Date(NOW.getTime() - 91 * DAY).toISOString(),
      deleted_at: null,
    },
  ];
  const admin = makeAdmin(rows);
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: string[]) => logs.push(args.join(" "));
  console.error = (...args: string[]) => logs.push(args.join(" "));
  let result;
  try {
    result = await runExportRetention({ admin, now: () => NOW });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(result, { removed: 2, pruned: 1, failedBatches: 0 });
  assert.equal(admin.state.removals.length, 1, "one batch for two objects");
  assert.deepEqual(admin.state.removals[0].sort(), [
    "acme/workspace_answers/ninety-one-days.csv",
    "acme/workspace_answers/three-hours.csv",
  ]);
  assert.ok(admin.state.removals[0].length <= 100);
  assert.deepEqual(
    admin.state.rows.map((row: any) => row.id).sort(),
    ["one-hour", "three-hours"],
    "the 91-day row was pruned after its object was removed; the audit rows stay 90 days",
  );
  const recent = admin.state.rows.find((row: any) => row.id === "one-hour");
  assert.equal(recent.status, "ready", "the one-hour row is untouched");
  const older = admin.state.rows.find((row: any) => row.id === "three-hours");
  assert.equal(older.status, "deleted", "the three-hour row is marked deleted");
  assert.ok(logs.includes("[exports.retention] removed=2 pruned=1"));
});

test("a failed Storage batch leaves its rows untouched and logs the count", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({
    id: `row-${index}`,
    storage_path: `acme/workspace_answers/row-${index}.csv`,
    status: "ready",
    created_at: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
    deleted_at: null,
  }));
  const admin = makeAdmin(rows, 2);
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: string[]) => logs.push(args.join(" "));
  console.error = (...args: string[]) => logs.push(args.join(" "));
  let result;
  try {
    result = await runExportRetention({ admin, now: () => NOW });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(result.removed, 100, "the first batch still succeeds");
  assert.equal(result.failedBatches, 1);
  assert.equal(admin.state.removeCalls, 2);
  assert.equal(rows.filter((row) => row.status === "deleted").length, 100);
  assert.equal(rows.filter((row) => row.status === "ready").length, 50);
  assert.ok(logs.some((line) => line.includes("storage batch failed rows=50")));
});
