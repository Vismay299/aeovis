import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { peekCached, cachedIf } from "./cache.ts";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";
import { cached } from "../cache/providerCache.ts";

const testSchema = z.object({
  keywords: z.array(z.string()),
  count: z.number(),
});

function createTestHarness() {
  const store = createMemoryCacheStore();
  const cacheDeps = {
    store,
    keepAlive: ((work: unknown) => Promise.resolve(work)) as typeof import("../keepAlive.js").keepAlive,
  };
  return { store, cacheDeps };
}

test("peekCached returns null on miss without writing anything", async () => {
  const { store, cacheDeps } = createTestHarness();
  const input = {
    namespace: "test.research",
    version: 1,
    keyParts: ["miss-query"],
    ttlSeconds: 600,
    schema: testSchema,
    scope: "global" as const,
  };

  const result = await peekCached(input, { cacheDeps });
  assert.equal(result, null);

  // Assert store is still empty
  const stored = await store.read("any-key");
  assert.equal(stored, null);
});

test("peekCached returns cached value on hit without calling fetcher", async () => {
  const { cacheDeps } = createTestHarness();
  const input = {
    namespace: "test.research",
    version: 1,
    keyParts: ["hit-query"],
    ttlSeconds: 600,
    schema: testSchema,
    scope: "global" as const,
  };

  // Seed cache via cached
  let fetcherCalls = 0;
  await cached(
    input,
    async () => {
      fetcherCalls += 1;
      return { keywords: ["seo", "keyword research"], count: 2 };
    },
    cacheDeps,
  );
  assert.equal(fetcherCalls, 1);

  // peekCached should find it and return value without calling any fetcher
  const hit = await peekCached(input, { cacheDeps });
  assert.ok(hit !== null);
  assert.deepEqual(hit.value, { keywords: ["seo", "keyword research"], count: 2 });
  assert.ok(typeof hit.fetchedAt === "string");
});

test("cachedIf with keep=false returns value, hit: false, writes nothing, and next call fetches again", async () => {
  const { cacheDeps } = createTestHarness();
  const input = {
    namespace: "test.research",
    version: 1,
    keyParts: ["empty-query"],
    ttlSeconds: 600,
    schema: testSchema,
    scope: "global" as const,
  };

  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return { keywords: [], count: 0 };
  };

  // keep returns false when count === 0
  const keep = (val: { count: number }) => val.count > 0;

  const first = await cachedIf(input, fetcher, keep, { cacheDeps });
  assert.equal(fetchCount, 1);
  assert.deepEqual(first.value, { keywords: [], count: 0 });
  assert.equal(first.hit, false);

  // Verify nothing was written to cache by peeking
  const peek = await peekCached(input, { cacheDeps });
  assert.equal(peek, null);

  // Next call fetches again because nothing was stored
  const second = await cachedIf(input, fetcher, keep, { cacheDeps });
  assert.equal(fetchCount, 2);
  assert.equal(second.hit, false);
});

test("cachedIf with keep=true caches value and subsequent call returns hit: true", async () => {
  const { cacheDeps } = createTestHarness();
  const input = {
    namespace: "test.research",
    version: 1,
    keyParts: ["good-query"],
    ttlSeconds: 600,
    schema: testSchema,
    scope: "global" as const,
  };

  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return { keywords: ["perceev"], count: 1 };
  };

  const keep = (val: { count: number }) => val.count > 0;

  const first = await cachedIf(input, fetcher, keep, { cacheDeps });
  assert.equal(fetchCount, 1);
  assert.deepEqual(first.value, { keywords: ["perceev"], count: 1 });
  assert.equal(first.hit, false);

  // Next call should hit cache
  const second = await cachedIf(input, fetcher, keep, { cacheDeps });
  assert.equal(fetchCount, 1);
  assert.equal(second.hit, true);
  assert.deepEqual(second.value, { keywords: ["perceev"], count: 1 });
});

test("a concurrent peek on the same key does not turn a real fetch into a cache-only miss", async () => {
  const { cacheDeps } = createTestHarness();
  const input = {
    namespace: "test.research",
    version: 1,
    keyParts: ["race-peek-first"],
    ttlSeconds: 600,
    schema: testSchema,
    scope: "global" as const,
  };
  let fetches = 0;
  const [peek, real] = await Promise.all([
    peekCached(input, { cacheDeps }),
    cachedIf(
      input,
      async () => {
        fetches += 1;
        return { keywords: ["a"], count: 1 };
      },
      () => true,
      { cacheDeps },
    ),
  ]);
  assert.equal(peek, null);
  assert.deepEqual(real.value, { keywords: ["a"], count: 1 });
  assert.equal(fetches, 1);
});

test("a peek that joins a cachedIf flight whose value is not kept is a miss, not an error", async () => {
  const { cacheDeps } = createTestHarness();
  const input = {
    namespace: "test.research",
    version: 1,
    keyParts: ["race-skip-first"],
    ttlSeconds: 600,
    schema: testSchema,
    scope: "global" as const,
  };
  const [real, peek] = await Promise.all([
    cachedIf(
      input,
      async () => ({ keywords: [], count: 0 }),
      (v) => v.count > 0,
      { cacheDeps },
    ),
    peekCached(input, { cacheDeps }),
  ]);
  assert.equal(real.hit, false);
  assert.equal(peek, null);
});
