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
