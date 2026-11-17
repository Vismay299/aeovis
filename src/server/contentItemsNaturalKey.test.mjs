import test from "node:test";
import assert from "node:assert/strict";
import { insertContentItem } from "./db/content.js";

/**
 * R3.5.2 — Natural key on content_items (job_id, cycle).
 *
 * Closes the die-between-insert-and-status window that creates duplicate
 * drafts. A crash between insertContentItem and the status write left the job
 * without an item_id, so a resume re-inserted instead of updating. With a
 * unique constraint on (job_id, cycle), a repeated insert in the crash window
 * returns the existing row instead of creating a duplicate.
 *
 * NO DATABASE IS NEEDED. These tests exercise the memory-mode path of
 * insertContentItem, which mirrors the DB constraint behaviour.
 */

function makeMemoryDeps() {
  const memory = new Map();
  return { memory, deps: { memory } };
}

test("R3.5.2 — insertContentItem includes cycle in the record", async () => {
  const { deps, memory } = makeMemoryDeps();
  const item = await insertContentItem(
    { job_id: "j1", brand: "Acme", playbook: "geo_article", cycle: 2, revision: 1 },
    deps
  );
  assert.equal(item.cycle, 2, "cycle must be stored on the record");
  assert.equal(item.revision, 1, "revision must also be stored");
  assert.equal(memory.size, 1);
});

test("R3.5.2 — insertContentItem defaults cycle to 1 when omitted", async () => {
  const { deps } = makeMemoryDeps();
  const item = await insertContentItem(
    { job_id: "j1", brand: "Acme", playbook: "geo_article" },
    deps
  );
  assert.equal(item.cycle, 1, "cycle must default to 1");
});

test("R3.5.2 — a repeated insert in the crash window returns the existing row, not a duplicate", async () => {
  const { deps, memory } = makeMemoryDeps();

  // First insert — the worker creates the item.
  const first = await insertContentItem(
    { job_id: "j1", brand: "Acme", playbook: "geo_article", cycle: 1, title: "Draft v1" },
    deps
  );
  assert.equal(memory.size, 1, "one row after first insert");

  // Second insert — the worker crashed before status write and resumed.
  const second = await insertContentItem(
    { job_id: "j1", brand: "Acme", playbook: "geo_article", cycle: 1, title: "Draft v1 (retry)" },
    deps
  );

  // The same row is returned, not a new one.
  assert.equal(memory.size, 1, "THE BUG: a duplicate row was created instead of returning the existing one");
  assert.equal(second.id, first.id, "the returned row must be the same row");
  assert.equal(second.title, "Draft v1 (retry)", "the existing row is updated with new data");
});

test("R3.5.2 — different cycles for the same job produce different rows", async () => {
  const { deps, memory } = makeMemoryDeps();

  const first = await insertContentItem(
    { job_id: "j1", brand: "Acme", playbook: "geo_article", cycle: 1 },
    deps
  );
  const second = await insertContentItem(
    { job_id: "j1", brand: "Acme", playbook: "geo_article", cycle: 2 },
    deps
  );

  assert.equal(memory.size, 2, "two different cycles produce two rows");
  assert.notEqual(first.id, second.id, "different cycles get different ids");
});

test("R3.5.2 — different jobs with the same cycle produce different rows", async () => {
  const { deps, memory } = makeMemoryDeps();

  await insertContentItem({ job_id: "j1", brand: "Acme", playbook: "geo_article", cycle: 1 }, deps);
  await insertContentItem({ job_id: "j2", brand: "Acme", playbook: "geo_article", cycle: 1 }, deps);

  assert.equal(memory.size, 2, "different jobs with same cycle produce two rows");
});

test("R3.5.2 — the unique constraint is documented in migration 016", async () => {
  const { readFileSync } = await import("node:fs");
  const migration = readFileSync(
    new URL("../../supabase/migrations/016_content_items_natural_key.sql", import.meta.url),
    "utf8"
  );
  assert.match(
    migration,
    /UNIQUE\s*\(\s*job_id\s*,\s*cycle\s*\)/,
    "migration 016 must declare a UNIQUE constraint on (job_id, cycle)"
  );
  assert.match(
    migration,
    /content_items_job_id_cycle_key/,
    "the constraint must have a named key for idempotent re-runs"
  );
});

// ---------------------------------------------------------------------------
// R3.5.6 — the DB branch must not rewrite the item id on conflict.
//
// Production, 2026-09-18 21:57 UTC: insertContentItem upserted a record
// carrying a FRESH `id` with onConflict "job_id,cycle", so a conflict ran
// `UPDATE content_items SET id = <new uuid>` on the row that
// content_jobs.item_id references → Postgres 23503
// (content_jobs_item_id_fkey). The fake client below is a real trap: it holds
// rows keyed on (job_id, cycle), applies an upsert the way Postgres would, and
// raises 23503 if a conflict update would change the id of a row an
// content_jobs.item_id points at.
// ---------------------------------------------------------------------------

function makePostgrestFake() {
  const rows = [];
  const payloads = [];
  const fkRefs = new Set(); // content_jobs.item_id values
  let seq = 0;

  const client = {
    from(table) {
      assert.equal(table, "content_items", "only content_items is faked here");
      return {
        upsert(record, options) {
          payloads.push({ ...record });
          assert.deepEqual(
            options,
            { onConflict: "job_id,cycle" },
            "the upsert must arbitrate on the natural key"
          );
          const existing = rows.find(
            (r) => r.job_id === record.job_id && r.cycle === record.cycle
          );
          if (existing) {
            const rewritesId =
              Object.prototype.hasOwnProperty.call(record, "id") &&
              record.id !== existing.id;
            if (rewritesId && fkRefs.has(existing.id)) {
              return {
                select: async () => ({
                  data: null,
                  error: {
                    code: "23503",
                    message:
                      "update or delete on table content_items violates foreign key " +
                      "constraint content_jobs_item_id_fkey on table content_jobs",
                  },
                }),
              };
            }
            // ON CONFLICT DO UPDATE: every key in the payload is overwritten.
            Object.assign(existing, record);
            const row = { ...existing };
            return { select: async () => ({ data: [row], error: null }) };
          }
          const inserted = { ...record };
          // Column defaults from migration 002 fill whatever the payload omits.
          if (inserted.id === undefined) inserted.id = `db-default-uuid-${++seq}`;
          if (inserted.created_at === undefined) inserted.created_at = `db-default-now-${seq}`;
          rows.push(inserted);
          const row = { ...inserted };
          return { select: async () => ({ data: [row], error: null }) };
        },
      };
    },
  };

  return { client, rows, payloads, fkRefs };
}

test("R3.5.6 — the upsert payload never carries `id` (it would become UPDATE SET id)", async () => {
  const { client, payloads } = makePostgrestFake();
  await insertContentItem({ job_id: "355b0237", brand: "Italica", playbook: "geo_article", cycle: 1 }, { client });
  assert.equal(payloads.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(payloads[0], "id"),
    false,
    "THE BUG: `id` in the upsert payload is `UPDATE ... SET id = <fresh uuid>` on conflict"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(payloads[0], "created_at"),
    false,
    "created_at must also come from the column default so a conflict cannot rewrite it"
  );
});

test("R3.5.6 — two inserts for the same (job_id, cycle) yield ONE row with the FIRST id", async () => {
  const { client, rows, payloads, fkRefs } = makePostgrestFake();

  const first = await insertContentItem(
    { job_id: "355b0237", brand: "Italica", playbook: "geo_article", cycle: 1, title: "Draft v1", status: "awaiting_approval" },
    { client }
  );
  assert.ok(first.id, "the first insert gets an id from the column default");
  // What contentWorker.js:805-809 does next: point the job row at this item.
  fkRefs.add(first.id);

  // The second execution of the same job (the 21:57 resume) — insertContentItem
  // mints a fresh uuid internally on every call, which is exactly what used to
  // reach the UPDATE SET list.
  const second = await insertContentItem(
    { job_id: "355b0237", brand: "Italica", playbook: "geo_article", cycle: 1, title: "Draft v1 (resumed)", status: "awaiting_approval" },
    { client }
  );

  assert.equal(rows.length, 1, "one row, not a duplicate draft");
  assert.equal(second.id, first.id, "the FIRST id survives — content_jobs.item_id still resolves");
  assert.equal(second.title, "Draft v1 (resumed)", "the existing row is updated, matching memory mode");
  assert.equal(second.created_at, first.created_at, "created_at is preserved, matching memory mode");
  assert.ok(
    payloads.every((p) => !Object.prototype.hasOwnProperty.call(p, "id")),
    "no UPDATE of `id` ever reached the client"
  );
});

test("R3.5.6 — the fake really does fire 23503 when an id rewrite reaches it", async () => {
  // Proves the trap above is a trap: feed the pre-fix payload shape directly.
  const { client, fkRefs } = makePostgrestFake();
  const inserted = await client
    .from("content_items")
    .upsert({ id: "item-A", job_id: "j1", cycle: 1 }, { onConflict: "job_id,cycle" })
    .select();
  assert.equal(inserted.data[0].id, "item-A");
  fkRefs.add("item-A");

  const conflict = await client
    .from("content_items")
    .upsert({ id: "item-B", job_id: "j1", cycle: 1 }, { onConflict: "job_id,cycle" })
    .select();
  assert.equal(conflict.error.code, "23503", "the pre-fix payload must trip the FK");
  assert.match(conflict.error.message, /content_jobs_item_id_fkey/);
});

test("R3.5.6 — an upsert that returns no row throws instead of returning undefined", async () => {
  const client = {
    from: () => ({ upsert: () => ({ select: async () => ({ data: [], error: null }) }) }),
  };
  await assert.rejects(
    () => insertContentItem({ job_id: "j1", brand: "Acme", playbook: "geo_article" }, { client }),
    /returned no row — the item was NOT written/
  );
});
