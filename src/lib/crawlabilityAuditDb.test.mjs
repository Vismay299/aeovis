/**
 * R4.3.1 — tests for crawlability audit persistence (db/crawlability.js).
 *
 * Tests use an in-memory mock Supabase client that records operations and
 * returns configurable responses. No real database connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { saveCrawlabilityAudit, getAuditHistory, getLatestAudit } from "./db/crawlability.js";

// ---------------------------------------------------------------------------
// Mock Supabase client
// ---------------------------------------------------------------------------

function createMockClient({ insertData = null, insertError = null, selectData = null } = {}) {
  const calls = [];
  let _selectData = selectData;

  const mockQuery = {
    insert(row) {
      calls.push({ op: "insert", args: [row] });
      return {
        select() {
          return {
            single() {
              if (insertError) return Promise.resolve({ data: null, error: insertError });
              const data = _selectData || { id: "test-id-123", ...row };
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
    upsert(row, opts) {
      calls.push({ op: "upsert", args: [row], opts });
      return {
        select() {
          return {
            single() {
              if (insertError) return Promise.resolve({ data: null, error: insertError });
              const data = _selectData || { id: "test-id-123", ...row };
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
  };

  const client = {
    from(table) {
      calls.push({ op: "from", table });
      return mockQuery;
    },
    _calls: calls,
  };

  return client;
}

// ---------------------------------------------------------------------------
// saveCrawlabilityAudit
// ---------------------------------------------------------------------------

test("saveCrawlabilityAudit throws when no client is configured", async () => {
  await assert.rejects(
    () => saveCrawlabilityAudit({ domain: "example.com", fetched_ok: true, summary: { open: 1, partial: 0, blocked: 0, total: 1 }, bots: [] }, { client: null }),
    (err) => {
      assert.ok(err.message.includes("Supabase is not configured"));
      return true;
    }
  );
});

test("saveCrawlabilityAudit throws when the write fails", async () => {
  const client = createMockClient({ insertError: { message: "relation does not exist" } });
  await assert.rejects(
    () => saveCrawlabilityAudit({ domain: "example.com", fetched_ok: true, summary: { open: 1, partial: 0, blocked: 0, total: 1 }, bots: [] }, { client }),
    (err) => {
      assert.ok(err.message.includes("Failed to save crawlability audit"));
      return true;
    }
  );
});

test("saveCrawlabilityAudit inserts into the right table with a normalized row", async () => {
  const client = createMockClient();
  const audit = {
    domain: "Example.com",
    testPath: "/blog",
    fetched_ok: true,
    robots_txt_status: "found",
    robots_malformed: false,
    fetch_error: null,
    llms_txt_present: true,
    summary: { open: 30, partial: 5, blocked: 2, total: 37 },
    bots: [{ name: "GPTBot", status: "blocked" }],
    diff: { changes: [{ name: "GPTBot", previous: "open", current: "blocked" }], summary: "GPTBot is now blocked", detected_at: "2026-01-01T00:00:00Z" },
  };

  const result = await saveCrawlabilityAudit(audit, { client });

  // Should have called from("crawlability_audits") then insert
  assert.equal(client._calls[0].op, "from");
  assert.equal(client._calls[0].table, "crawlability_audits");
  assert.equal(client._calls[1].op, "insert");

  // Domain should be normalized to lowercase
  const upsertedRow = client._calls[1].args[0];
  assert.equal(upsertedRow.domain, "example.com");
  assert.equal(upsertedRow.test_path, "/blog");
  assert.equal(upsertedRow.fetched_ok, true);
  assert.equal(upsertedRow.robots_txt_status, "found");
  assert.equal(upsertedRow.robots_malformed, false);
  assert.equal(upsertedRow.llms_txt_present, true);
  assert.deepEqual(upsertedRow.summary, { open: 30, partial: 5, blocked: 2, total: 37 });
  assert.deepEqual(upsertedRow.bots, [{ name: "GPTBot", status: "blocked" }]);
  assert.ok(upsertedRow.diff);

  // Should return the saved row
  assert.ok(result);
  assert.equal(result.id, "test-id-123");
});

test("saveCrawlabilityAudit inserts without an on_conflict option", async () => {
  const client = createMockClient();
  await saveCrawlabilityAudit({
    domain: "example.com",
    fetched_ok: true,
    summary: { open: 0, partial: 0, blocked: 0, total: 0 },
  }, { client });

  assert.equal(client._calls[1].op, "insert");
  // R3.1.9: NOT upsert. PostgREST's on_conflict names columns, and the
  // per-minute constraint is an EXPRESSION index — the old
  // `onConflict: "domain,date_trunc('minute', audited_at)"` made every save
  // fail, which the route caught and logged, so audit history was never
  // written at all while the endpoint still answered 200.
  assert.ok(!client._calls[1].opts, "an insert carries no on_conflict option");
});

test("R3.1.9 — a second audit in the same minute REPLACES the first instead of failing", async () => {
  // The per-minute unique index fires as 23505; the newer audit wins.
  const calls = [];
  const client = {
    from(table) {
      calls.push({ op: "from", table });
      return {
        insert(row) {
          calls.push({ op: "insert", args: [row] });
          return {
            select: () => ({
              single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
            }),
          };
        },
        update(row) {
          calls.push({ op: "update", args: [row], filters: [] });
          const chain = {
            eq(col, val) {
              calls.at(-1).filters.push(["eq", col, val]);
              return chain;
            },
            gte(col, val) {
              calls.at(-1).filters.push(["gte", col, val]);
              return chain;
            },
            lt(col, val) {
              calls.at(-1).filters.push(["lt", col, val]);
              return chain;
            },
            select: () => ({ single: async () => ({ data: { id: "replaced-1", ...row }, error: null }) }),
          };
          return chain;
        },
      };
    },
  };

  const result = await saveCrawlabilityAudit(
    { domain: "Example.com", fetched_ok: true, summary: { open: 1, partial: 0, blocked: 0, total: 1 } },
    { client }
  );

  assert.equal(result.id, "replaced-1", "the duplicate must resolve to the stored row, not throw");
  const update = calls.find((c) => c.op === "update");
  assert.ok(update, "a 23505 must be handled, not rethrown");
  assert.deepEqual(update.filters[0], ["eq", "domain", "example.com"]);
  assert.equal(update.filters[1][0], "gte");
  assert.equal(update.filters[2][0], "lt");
  const windowMs = new Date(update.filters[2][2]).getTime() - new Date(update.filters[1][2]).getTime();
  assert.equal(windowMs, 60_000, "the replace must be scoped to exactly the conflicting minute");
});

test("R3.1.9 — a non-duplicate insert error still throws", async () => {
  const client = createMockClient({
    insertError: { code: "42501", message: "permission denied" },
  });
  await assert.rejects(
    () =>
      saveCrawlabilityAudit(
        { domain: "example.com", fetched_ok: true, summary: { open: 0, partial: 0, blocked: 0, total: 0 } },
        { client }
      ),
    /permission denied/
  );
});

test("saveCrawlabilityAudit defaults testPath to /", async () => {
  const client = createMockClient();
  await saveCrawlabilityAudit({
    domain: "example.com",
    fetched_ok: true,
    summary: { open: 0, partial: 0, blocked: 0, total: 0 },
  }, { client });

  const upsertedRow = client._calls[1].args[0];
  assert.equal(upsertedRow.test_path, "/");
});

test("saveCrawlabilityAudit sets diff to null when not provided", async () => {
  const client = createMockClient();
  await saveCrawlabilityAudit({
    domain: "example.com",
    fetched_ok: true,
    summary: { open: 0, partial: 0, blocked: 0, total: 0 },
  }, { client });

  const upsertedRow = client._calls[1].args[0];
  assert.equal(upsertedRow.diff, null);
});

// ---------------------------------------------------------------------------
// getAuditHistory
// ---------------------------------------------------------------------------

test("getAuditHistory returns empty array when no client", async () => {
  const result = await getAuditHistory("example.com", 10, { client: null });
  assert.deepEqual(result, []);
});

test("getAuditHistory returns empty array on error", async () => {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return Promise.resolve({ data: null, error: { message: "db error" } }); },
  };
  const client = { from() { return chain; } };

  const result = await getAuditHistory("example.com", 10, { client });
  assert.deepEqual(result, []);
});

test("getAuditHistory normalizes domain to lowercase", async () => {
  const eqCalls = [];
  const chain = {
    select() { return chain; },
    eq(field, value) { eqCalls.push({ field, value }); return chain; },
    order() { return chain; },
    limit() { return Promise.resolve({ data: [], error: null }); },
  };
  const client = { from() { return chain; } };

  await getAuditHistory("EXAMPLE.COM", 5, { client });
  assert.ok(eqCalls.some((c) => c.field === "domain" && c.value === "example.com"));
});

// ---------------------------------------------------------------------------
// getLatestAudit
// ---------------------------------------------------------------------------

test("getLatestAudit returns null when no history exists", async () => {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return Promise.resolve({ data: [], error: null }); },
  };
  const client = { from() { return chain; } };

  const result = await getLatestAudit("example.com", { client });
  assert.equal(result, null);
});

test("getLatestAudit returns the first item from history", async () => {
  const mockRow = { id: "audit-1", domain: "example.com", audited_at: "2026-01-01T00:00:00Z" };
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return Promise.resolve({ data: [mockRow], error: null }); },
  };
  const client = { from() { return chain; } };

  const result = await getLatestAudit("example.com", { client });
  assert.deepEqual(result, mockRow);
});
