/**
 * F05-AC-04 — the key registry: builder shapes, workspace scoping and
 * `invalidateWorkspace`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_DOMAINS,
  invalidateWorkspace,
  isWorkspaceKey,
  keys,
  stableStringify,
} from "./keys.ts";

test("every builder returns its documented shape", () => {
  assert.deepEqual(keys.features("a"), ["features", "a"]);
  assert.deepEqual(keys.overview("a"), ["overview", "a"]);
  assert.deepEqual(keys.gsc("a"), ["gsc", "a"]);
  assert.deepEqual(keys.panel("a"), ["panel", "a", "default"]);
  assert.deepEqual(keys.panel("a", "geo"), ["panel", "a", "geo"]);
  assert.deepEqual(keys.scanStatus("a", "j1"), ["scanStatus", "a", "j1"]);
  assert.deepEqual(keys.jobStatus("a", "j1"), ["jobStatus", "a", "j1"]);
  assert.deepEqual(keys.scanReport("s1"), ["scanReport", "s1"]);
  assert.deepEqual(keys.usage("a", "30d", "UTC"), ["usage", "a", "30d", "UTC"]);
  assert.deepEqual(keys.price("a", "scan", "{}"), ["price", "a", "scan", "{}"]);
  assert.deepEqual(keys.projectContext("a"), ["projectContext", "a"]);
});

test("every workspace-scoped builder puts brandKey second and is a workspace domain", () => {
  const scoped = [
    keys.features("acme"),
    keys.overview("acme"),
    keys.gsc("acme"),
    keys.panel("acme"),
    keys.scanStatus("acme", "j"),
    keys.jobStatus("acme", "j"),
    keys.usage("acme", "30d", "UTC"),
    keys.price("acme", "scan", "{}"),
    keys.projectContext("acme"),
  ];
  assert.equal(scoped.length, WORKSPACE_DOMAINS.size);
  for (const key of scoped) {
    assert.equal(key[1], "acme");
    assert.ok(WORKSPACE_DOMAINS.has(key[0]), key[0]);
    assert.equal(isWorkspaceKey(key, "acme"), true, key[0]);
    assert.equal(isWorkspaceKey(key, "other"), false, key[0]);
  }
  assert.equal(WORKSPACE_DOMAINS.has("scanReport"), false);
});

test("isWorkspaceKey matches only the right workspace and never an id-addressed record", () => {
  assert.equal(isWorkspaceKey(["overview", "a"], "a"), true);
  assert.equal(isWorkspaceKey(["overview", "b"], "a"), false);
  assert.equal(isWorkspaceKey(["scanReport", "x"], "x"), false);
  assert.equal(isWorkspaceKey([], "a"), false);
  assert.equal(isWorkspaceKey(["unknownDomain", "a"], "a"), false);
  assert.equal(isWorkspaceKey([42, "a"], "a"), false);
});

test("invalidateWorkspace passes a predicate matching only that workspace's keys", async () => {
  const filters: Array<{
    predicate(q: { queryKey: readonly unknown[] }): boolean;
  }> = [];
  const client = {
    invalidateQueries: async (f: (typeof filters)[number]) => {
      filters.push(f);
    },
  };
  await invalidateWorkspace(client, "a");
  assert.equal(filters.length, 1);
  const matches = (queryKey: readonly unknown[]) =>
    filters[0].predicate({ queryKey });
  assert.equal(matches(keys.overview("a")), true);
  assert.equal(matches(keys.panel("a", "geo")), true);
  assert.equal(matches(keys.scanStatus("a", "j")), true);
  assert.equal(matches(keys.overview("b")), false);
  assert.equal(matches(keys.gsc("b")), false);
  assert.equal(matches(keys.scanReport("a")), false);
});

test("stableStringify sorts object keys at every depth", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 1, c: 2 } }),
    '{"a":{"c":2,"d":1},"b":1}',
  );
  assert.equal(
    stableStringify({ z: [{ y: 1, x: 2 }], a: null }),
    '{"a":null,"z":[{"x":2,"y":1}]}',
  );
  assert.equal(stableStringify([3, 1, 2]), "[3,1,2]");
  assert.equal(stableStringify("s"), '"s"');
  assert.equal(stableStringify(null), "null");
});

test("stableStringify serialises toJSON values (a Date) instead of emptying them", () => {
  assert.equal(
    stableStringify({ since: new Date("2026-01-01T00:00:00.000Z") }),
    '{"since":"2026-01-01T00:00:00.000Z"}',
  );
  assert.notEqual(
    stableStringify({ since: new Date("2026-01-01T00:00:00.000Z") }),
    stableStringify({ since: new Date("2026-06-01T00:00:00.000Z") }),
  );
  assert.equal(
    stableStringify({ v: { toJSON: () => ({ b: 1, a: 2 }) } }),
    '{"v":{"a":2,"b":1}}',
  );
});

test("stableStringify gives the same string whatever the key insertion order", () => {
  assert.equal(
    stableStringify({ a: 1, b: { c: 1, d: 2 } }),
    stableStringify({ b: { d: 2, c: 1 }, a: 1 }),
  );
});
