import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveSession,
  consumeKickoff,
  createSession,
  deriveTitle,
  getSession,
  listSessions,
  renameSession,
  setTitleIfNew,
} from "./sessions.ts";

type Row = Record<string, any>;

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const now = "2026-11-01T00:00:00.000Z";
  // Raw values the repository handed to PostgREST, so a regression to
  // `.eq("kickoff", object)` (which encodes as "[object Object]") fails here.
  const filterCalls: Array<[string, unknown, string]> = [];

  function matches(row: Row, filters: Array<[string, any, string]>) {
    return filters.every(([column, value, op]) => {
      const current = row[column];
      if (op === "is") return value === null ? current == null : current === value;
      if (op === "lt") return current < value;
      if (op === "json-eq") return JSON.stringify(current) === value;
      if (current && typeof current === "object" && value && typeof value === "object") {
        return JSON.stringify(current) === JSON.stringify(value);
      }
      return current === value;
    });
  }

  function query(table: string) {
    const filters: Array<[string, any, string]> = [];
    const orders: Array<[string, boolean]> = [];
    let limit: number | null = null;
    let action: { kind: "insert"; row: Row } | { kind: "update"; patch: Row } | null = null;

    const run = () => {
      const rows = (tables[table] ??= []);
      if (action?.kind === "insert") {
        const row: Row = {
          id: crypto.randomUUID(),
          title: "New chat",
          summary: null,
          compacted_through_seq: null,
          kickoff: null,
          archived_at: null,
          created_at: now,
          updated_at: now,
          ...action.row,
        };
        rows.push(row);
        return { data: [{ ...row }], error: null };
      }
      if (action?.kind === "update") {
        const hit = rows.filter((row) => matches(row, filters));
        for (const row of hit) Object.assign(row, action.patch);
        return { data: hit.map((row) => ({ ...row })), error: null };
      }
      let out = rows.filter((row) => matches(row, filters));
      if (orders.length > 0) {
        out = out.slice().sort((a, b) => {
          for (const [column, ascending] of orders) {
            if (a[column] < b[column]) return ascending ? -1 : 1;
            if (a[column] > b[column]) return ascending ? 1 : -1;
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
        filters.push([column, value, "eq"]);
        return builder;
      },
      filter(column: string, op: string, value: unknown) {
        filterCalls.push([column, value, `json-${op}`]);
        filters.push([column, value, `json-${op}`]);
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push([column, value, "is"]);
        return builder;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orders.push([column, opts?.ascending !== false]);
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      insert(row: Row) {
        action = { kind: "insert", row };
        return builder;
      },
      update(patch: Row) {
        action = { kind: "update", patch };
        return builder;
      },
      maybeSingle() {
        const result = run();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      single() {
        const result = run();
        return Promise.resolve(
          result.data.length > 0 ? { data: result.data[0], error: null } : { data: null, error: { message: "no rows" } },
        );
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  return { admin: { from: (table: string) => query(table) } as any, tables, filterCalls };
}

test("deriveTitle collapses whitespace and uses the 57 + ellipsis rule", () => {
  assert.equal(deriveTitle(""), "New chat");
  assert.equal(deriveTitle("   \n\t "), "New chat");
  assert.equal(deriveTitle("  Which   competitors\nname us? "), "Which competitors name us?");
  assert.equal(deriveTitle("x".repeat(60)), "x".repeat(60));
  assert.equal(deriveTitle("x".repeat(61)), "x".repeat(57) + "…");
  assert.equal(deriveTitle("x".repeat(57) + "…"), "x".repeat(57) + "…");
});

test("createSession inserts the default title and returns a kickoff when given", async () => {
  const { admin, tables } = makeAdmin({ assistant_sessions: [] });
  const plain = await createSession(admin, { brandKey: "brand-a", userId: "user-1" });
  assert.equal(plain.title, "New chat");
  assert.equal(plain.brandKey, "brand-a");
  assert.equal(plain.kickoff, null);

  const kicked = await createSession(admin, {
    brandKey: "brand-a",
    userId: "user-1",
    kickoff: { kind: "generate_report", templateId: "tpl-1" },
  });
  assert.deepEqual(kicked.kickoff, { kind: "generate_report", templateId: "tpl-1" });
  assert.equal(tables.assistant_sessions.length, 2);
});

test("createSession can create the session already titled, in a single insert", async () => {
  const { admin, tables } = makeAdmin({ assistant_sessions: [] });
  const titled = await createSession(admin, {
    brandKey: "brand-a",
    userId: "user-1",
    kickoff: { kind: "generate_report", templateId: "tpl-1" },
    title: "Report: Monthly check-in",
  });
  assert.equal(titled.title, "Report: Monthly check-in");
  assert.deepEqual(titled.kickoff, { kind: "generate_report", templateId: "tpl-1" });
  assert.equal(tables.assistant_sessions.length, 1);
  assert.equal(tables.assistant_sessions[0]!.title, "Report: Monthly check-in");
});

test("listSessions is newest first and excludes archived rows", async () => {
  const { admin } = makeAdmin({
    assistant_sessions: [
      { id: "s1", brand_key: "brand-a", user_id: "user-1", title: "Old", updated_at: "2026-10-01T00:00:00Z", archived_at: null },
      { id: "s2", brand_key: "brand-a", user_id: "user-1", title: "New", updated_at: "2026-10-03T00:00:00Z", archived_at: null },
      { id: "s3", brand_key: "brand-a", user_id: "user-1", title: "Archived", updated_at: "2026-10-04T00:00:00Z", archived_at: "2026-10-04T00:00:00Z" },
      { id: "s4", brand_key: "brand-a", user_id: "user-2", title: "Other user", updated_at: "2026-10-05T00:00:00Z", archived_at: null },
    ],
  });
  const rows = await listSessions(admin, { brandKey: "brand-a", userId: "user-1" });
  assert.deepEqual(rows.map((row) => row.id), ["s2", "s1"]);
  const limited = await listSessions(admin, { brandKey: "brand-a", userId: "user-1", limit: 1 });
  assert.deepEqual(limited.map((row) => row.id), ["s2"]);
});

test("getSession is null for an archived or foreign session", async () => {
  const { admin } = makeAdmin({
    assistant_sessions: [
      { id: "mine", brand_key: "brand-a", user_id: "user-1", title: "Mine", archived_at: null },
      { id: "archived", brand_key: "brand-a", user_id: "user-1", title: "Gone", archived_at: "2026-10-04T00:00:00Z" },
      { id: "foreign", brand_key: "brand-a", user_id: "user-2", title: "Not mine", archived_at: null },
      { id: "other-brand", brand_key: "brand-b", user_id: "user-1", title: "Other workspace", archived_at: null },
    ],
  });
  assert.equal((await getSession(admin, { id: "mine", brandKey: "brand-a", userId: "user-1" }))?.title, "Mine");
  assert.equal(await getSession(admin, { id: "archived", brandKey: "brand-a", userId: "user-1" }), null);
  assert.equal(await getSession(admin, { id: "foreign", brandKey: "brand-a", userId: "user-1" }), null);
  assert.equal(await getSession(admin, { id: "other-brand", brandKey: "brand-a", userId: "user-1" }), null);
});

test("archiveSession hides the row and is idempotent", async () => {
  const { admin } = makeAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "brand-a", user_id: "user-1", title: "Chat", archived_at: null }],
  });
  assert.equal(await archiveSession(admin, { id: "s1", brandKey: "brand-a", userId: "user-1" }), true);
  assert.equal(await getSession(admin, { id: "s1", brandKey: "brand-a", userId: "user-1" }), null);
  assert.equal(await archiveSession(admin, { id: "s1", brandKey: "brand-a", userId: "user-1" }), false);
});

test("renameSession returns the new title and refuses archived or foreign rows", async () => {
  const { admin } = makeAdmin({
    assistant_sessions: [
      { id: "mine", brand_key: "brand-a", user_id: "user-1", title: "New chat", archived_at: null },
      { id: "archived", brand_key: "brand-a", user_id: "user-1", title: "Old", archived_at: "2026-10-01T00:00:00Z" },
      { id: "foreign", brand_key: "brand-a", user_id: "user-2", title: "Theirs", archived_at: null },
    ],
  });
  const renamed = await renameSession(admin, { id: "mine", brandKey: "brand-a", userId: "user-1", title: "Q4 plan" });
  assert.equal(renamed?.title, "Q4 plan");
  assert.equal(
    await renameSession(admin, { id: "archived", brandKey: "brand-a", userId: "user-1", title: "x" }),
    null,
  );
  assert.equal(
    await renameSession(admin, { id: "foreign", brandKey: "brand-a", userId: "user-1", title: "x" }),
    null,
  );
});

test("setTitleIfNew replaces only the default title", async () => {
  const { admin, tables } = makeAdmin({
    assistant_sessions: [
      { id: "new", brand_key: "brand-a", user_id: "user-1", title: "New chat", archived_at: null },
      { id: "renamed", brand_key: "brand-a", user_id: "user-1", title: "My own title", archived_at: null },
    ],
  });
  assert.equal(await setTitleIfNew(admin, "new", "  Which competitors   name us? "), true);
  assert.equal(tables.assistant_sessions.find((row) => row.id === "new")?.title, "Which competitors name us?");
  assert.equal(await setTitleIfNew(admin, "new", "A second message"), false);
  assert.equal(await setTitleIfNew(admin, "renamed", "A second message"), false);
  assert.equal(tables.assistant_sessions.find((row) => row.id === "renamed")?.title, "My own title");
  assert.equal(await setTitleIfNew(admin, "renamed", ""), false);
});

test("consumeKickoff returns the object once and clears it", async () => {
  const { admin, tables, filterCalls } = makeAdmin({
    assistant_sessions: [
      { id: "s1", brand_key: "brand-a", user_id: "user-1", kickoff: { kind: "generate_report" }, archived_at: null },
      { id: "s2", brand_key: "brand-a", user_id: "user-1", kickoff: null, archived_at: null },
    ],
  });
  assert.deepEqual(await consumeKickoff(admin, "s1"), { kind: "generate_report" });
  assert.equal(tables.assistant_sessions.find((row) => row.id === "s1")?.kickoff, null);
  // The clear must reach PostgREST as a JSON literal; an object encodes as
  // "[object Object]" and the jsonb comparison never matches in production.
  const kickoffFilter = filterCalls.find(([column]) => column === "kickoff");
  assert.deepEqual(kickoffFilter, ["kickoff", '{"kind":"generate_report"}', "json-eq"]);
  assert.equal(String(kickoffFilter?.[1]).includes("[object Object]"), false);
  assert.equal(await consumeKickoff(admin, "s1"), null);
  assert.equal(await consumeKickoff(admin, "s2"), null);
});
