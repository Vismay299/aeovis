import test from "node:test";
import assert from "node:assert/strict";
import { fitParts, insertMessage, loadMessages, toUIMessage } from "./messages.ts";

type Row = Record<string, any>;

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  let seq = 10;

  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const gts: Array<[string, number]> = [];
    const orders: Array<[string, boolean]> = [];
    let limit: number | null = null;
    let inserted: Row | null = null;
    const rows = () => (tables[table] ??= []);
    const run = () => {
      if (inserted) {
        const row: Row = {
          session_id: inserted.session_id,
          id: inserted.id,
          brand_key: inserted.brand_key,
          seq: seq++,
          role: inserted.role,
          parts: inserted.parts,
          metadata: inserted.metadata ?? {},
          turn_id: inserted.turn_id ?? null,
          created_at: inserted.created_at ?? "2026-11-01T00:00:00.000Z",
        };
        rows().push(row);
        return { data: [{ ...row }], error: null };
      }
      let out = rows().filter(
        (row) =>
          filters.every(([column, value]) => row[column] === value) &&
          gts.every(([column, value]) => Number(row[column]) > value),
      );
      if (orders.length > 0) {
        out = out.slice().sort((a, b) => {
          for (const [column, ascending] of orders) {
            const left = column === "seq" ? Number(a[column]) : a[column];
            const right = column === "seq" ? Number(b[column]) : b[column];
            if (left < right) return ascending ? -1 : 1;
            if (left > right) return ascending ? 1 : -1;
          }
          return 0;
        });
      }
      if (limit !== null) out = out.slice(0, limit);
      return { data: out.map((row) => ({ ...row })), error: null };
    };
    const builder: any = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      gt(column: string, value: number) {
        gts.push([column, Number(value)]);
        return builder;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orders.push([column, opts?.ascending !== false]);
        return builder;
      },
      limit(value: number) {
        limit = value;
        return builder;
      },
      insert(row: Row) {
        inserted = row;
        return builder;
      },
      single() {
        return Promise.resolve({ data: run().data[0] ?? null, error: null });
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  return { admin: { from: (table: string) => query(table) } as any, tables };
}

const ROW = {
  session_id: "s1",
  id: "m2",
  brand_key: "brand-a",
  seq: "2",
  role: "assistant",
  parts: [{ type: "text", text: "second" }],
  metadata: { kind: "chat" },
  turn_id: "t1",
  created_at: "2026-11-01T00:01:00.000Z",
};

test("loadMessages pages by seq so long chats are not truncated at max_rows", async () => {
  const seed = Array.from({ length: 25 }, (_, i) => ({ ...ROW, id: `m${i + 1}`, seq: String(i + 1) }));
  const { admin } = makeAdmin({ assistant_messages: seed });
  const rows = await loadMessages(admin, "s1", { pageSize: 10 });
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.map((row) => row.seq), Array.from({ length: 25 }, (_, i) => i + 1));
});

test("loadMessages returns rows in seq order with camelCase fields", async () => {
  const { admin } = makeAdmin({
    assistant_messages: [
      { ...ROW, id: "m1", seq: "1", created_at: "2026-11-01T00:00:00.000Z" },
      ROW,
      { ...ROW, id: "m3", seq: "3", created_at: "2026-11-01T00:02:00.000Z" },
    ],
  });
  const rows = await loadMessages(admin, "s1");
  assert.deepEqual(rows.map((row) => row.id), ["m1", "m2", "m3"]);
  assert.equal(rows[1].sessionId, "s1");
  assert.equal(rows[1].brandKey, "brand-a");
  assert.equal(rows[1].seq, 2);
  assert.equal(rows[1].turnId, "t1");
  assert.deepEqual(rows[1].metadata, { kind: "chat" });
});

test("insertMessage stores the row and returns the generated seq", async () => {
  const { admin, tables } = makeAdmin({ assistant_messages: [] });
  const stored = await insertMessage(admin, {
    sessionId: "s1",
    id: "u_1",
    brandKey: "brand-a",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    turnId: "t1",
  });
  assert.equal(stored.id, "u_1");
  assert.equal(stored.seq, 10);
  assert.deepEqual(stored.metadata, {});
  assert.equal(tables.assistant_messages.length, 1);
  assert.deepEqual(tables.assistant_messages[0].parts, [{ type: "text", text: "hello" }]);
});

test("toUIMessage carries id, role, parts and metadata", () => {
  const message = toUIMessage({
    sessionId: "s1",
    id: "m2",
    brandKey: "brand-a",
    seq: 2,
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { kind: "chat" },
    turnId: "t1",
    createdAt: "2026-11-01T00:01:00.000Z",
  });
  assert.deepEqual(message, {
    id: "m2",
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { kind: "chat" },
  });
});

test("fitParts leaves a message under the cap untouched", () => {
  const parts = [
    { type: "text", text: "hello" },
    { type: "tool-list_scans", toolCallId: "c1", state: "output-available", output: { status: "success", data: { rows: [1] } } },
  ];
  assert.deepEqual(fitParts(parts, 1_000_000), parts);
});

test("fitParts replaces the oldest tool output.data first, and only tool parts", () => {
  const data = (marker: string) => ({ status: "success", data: { marker, body: marker.repeat(200) } });
  const parts = [
    { type: "text", text: "lead" },
    { type: "tool-list_scans", toolCallId: "c1", state: "output-available", output: data("a") },
    { type: "tool-get_scan_report", toolCallId: "c2", state: "output-available", output: data("b") },
    { type: "tool-get_scan_answer", toolCallId: "c3", state: "output-available", output: data("c") },
  ];
  const replace = (count: number) => {
    const copy = JSON.parse(JSON.stringify(parts));
    for (let i = 1; i <= count; i += 1) {
      copy[i].output.data = { omitted: true, reason: "size" };
    }
    return copy;
  };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  const oneReplaced = fitParts(parts, size(replace(1)));
  assert.deepEqual((oneReplaced[1] as any).output.data, { omitted: true, reason: "size" });
  assert.equal((oneReplaced[2] as any).output.data.marker, "b");
  assert.equal((oneReplaced[3] as any).output.data.marker, "c");
  assert.equal((oneReplaced[0] as any).text, "lead");

  const twoReplaced = fitParts(parts, size(replace(2)));
  assert.deepEqual((twoReplaced[1] as any).output.data, { omitted: true, reason: "size" });
  assert.deepEqual((twoReplaced[2] as any).output.data, { omitted: true, reason: "size" });
  assert.equal((twoReplaced[3] as any).output.data.marker, "c");
});

test("fitParts does not mutate its input and skips parts already omitted", () => {
  const parts = [
    { type: "tool-list_scans", toolCallId: "c1", output: { status: "success", data: { omitted: true, reason: "size" } } },
    { type: "tool-list_scans", toolCallId: "c2", output: { status: "success", data: { body: "x".repeat(200) } } },
  ];
  const before = JSON.stringify(parts);
  const fitted = fitParts(parts, 10);
  assert.equal(JSON.stringify(parts), before);
  assert.deepEqual(fitted[0], parts[0]);
  assert.deepEqual((fitted[1] as any).output.data, { omitted: true, reason: "size" });
});
