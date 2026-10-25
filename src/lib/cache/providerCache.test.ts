import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { cacheKey, cached, stableStringify, CACHE_INLINE_MAX_BYTES } from "./providerCache.ts";
import { createMemoryCacheStore } from "./memoryStore.ts";
import type { MemoryCacheStore } from "./memoryStore.ts";

const schema = z.object({ ok: z.boolean() });
const input = {
  namespace: "qa",
  version: 3,
  keyParts: [{ b: 1, a: 2 }],
  ttlSeconds: 600,
  schema,
  scope: "workspace" as const,
  brandKey: "qa-brand.example",
};

function harness() {
  const store: MemoryCacheStore = createMemoryCacheStore();
  const lines: unknown[][] = [];
  const logger = {
    lines,
    warn: (...args: unknown[]) => {
      lines.push(args);
    },
    error: (...args: unknown[]) => {
      lines.push(args);
    },
  };
  const held: Array<Promise<unknown>> = [];
  const deps = {
    store,
    logger,
    keepAlive: ((work: unknown, _opts?: unknown) => {
      held.push(Promise.resolve(work));
      return Promise.resolve();
    }) as typeof import("../keepAlive.js").keepAlive,
  };
  return { store, lines, held, deps };
}

test("key stability: key order does not change the key, brands and scope do", () => {
  const first = cacheKey({ namespace: "n", version: 1, keyParts: [{ b: 1, a: 2 }], scope: "workspace", brandKey: "a.example" });
  const second = cacheKey({ namespace: "n", version: 1, keyParts: [{ a: 2, b: 1 }], scope: "workspace", brandKey: "a.example" });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  const otherBrand = cacheKey({ namespace: "n", version: 1, keyParts: [{ b: 1, a: 2 }], scope: "workspace", brandKey: "b.example" });
  assert.notEqual(first, otherBrand);
  const global = cacheKey({ namespace: "n", version: 1, keyParts: [{ b: 1, a: 2 }], scope: "global" });
  const globalOther = cacheKey({ namespace: "n", version: 1, keyParts: [{ b: 1, a: 2 }], scope: "global", brandKey: "b.example" });
  assert.equal(global, globalOther);
  assert.notEqual(first, global);
});

test("stableStringify sorts object keys recursively and keeps array order", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  assert.equal(
    stableStringify({ outer: { z: 1, a: [3, 2] } }),
    stableStringify({ outer: { a: [3, 2], z: 1 } })
  );
});

test("miss stores, hit returns the row, expired rows refetch", async () => {
  const { store, held, deps } = harness();
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { ok: true };
  };
  const miss = await cached(input, fetcher, deps);
  await Promise.all(held.splice(0));
  assert.equal(miss.hit, false);
  assert.deepEqual(miss.value, { ok: true });
  assert.equal(calls, 1);

  const hit = await cached(input, fetcher, deps);
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.value, { ok: true });
  assert.equal(calls, 1);

  const row = await store.read(miss && (await store.read(cacheKey(input))) ? cacheKey(input) : cacheKey(input));
  assert.ok(row);
  await store.write({
    key: row?.key as string,
    namespace: "qa",
    version: 3,
    scope: "workspace",
    brandKey: "qa-brand.example",
    value: { ok: true },
    storagePath: null,
    sizeBytes: 10,
    fetchedAt: new Date(Date.now() - 10_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const refetch = await cached(input, fetcher, deps);
  await Promise.all(held.splice(0));
  assert.equal(refetch.hit, false);
  assert.equal(calls, 2);
});

test("a row that fails the schema is a miss and warns with namespace only", async () => {
  const { store, lines, held, deps } = harness();
  await cached(input, async () => ({ ok: true }), deps);
  await Promise.all(held.splice(0));
  const key = cacheKey(input);
  const row = await store.read(key);
  assert.ok(row);
  await store.write({ ...(row as NonNullable<typeof row>), value: { ok: "yes" } });
  lines.length = 0;
  let calls = 0;
  const refetch = await cached(input, async () => {
    calls += 1;
    return { ok: true };
  }, deps);
  await Promise.all(held.splice(0));
  assert.equal(refetch.hit, false);
  assert.equal(calls, 1);
  const warned = lines.filter((line) => line[0] === "[cache] schema mismatch");
  assert.equal(warned.length, 1);
  assert.deepEqual(warned[0][1], { namespace: "qa", version: 3 });
  assert.ok(!JSON.stringify(lines).includes("yes"));
});

test("a fetcher returning invalid data throws and stores nothing", async () => {
  const { store, held, deps } = harness();
  await assert.rejects(
    () => cached({ ...input, schema }, async () => ({ ok: "nope" }) as unknown as { ok: boolean }, deps),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === "cache_fetcher_invalid"
  );
  await Promise.all(held.splice(0));
  assert.equal(await store.read(cacheKey(input)), null);
  assert.equal(store.rows.size, 0);
});

test("bodies over 256 KB go to storage, not the row", async () => {
  const { store, held, deps } = harness();
  const big = { text: "x".repeat(CACHE_INLINE_MAX_BYTES + 16) };
  const bigSchema = z.object({ text: z.string() });
  const result = await cached({ ...input, keyParts: ["big"], schema: bigSchema }, async () => big, deps);
  await Promise.all(held.splice(0));
  assert.equal(result.hit, false);
  const key = cacheKey({ ...input, keyParts: ["big"] });
  const row = await store.read(key);
  assert.ok(row);
  assert.equal(row?.value, null);
  assert.ok(row?.storagePath?.startsWith("provider-cache/qa/"));
  assert.ok((row?.sizeBytes as number) > CACHE_INLINE_MAX_BYTES);
  assert.equal(await store.readBody(row?.storagePath as string), JSON.stringify(big));
  const hit = await cached({ ...input, keyParts: ["big"], schema: bigSchema }, async () => ({ text: "fresh" }), deps);
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.value, big);
});

test("two concurrent misses call the fetcher once", async () => {
  const { held, deps } = harness();
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true };
  };
  const [first, second] = await Promise.all([cached({ ...input, keyParts: ["flight"] }, fetcher, deps), cached({ ...input, keyParts: ["flight"] }, fetcher, deps)]);
  await Promise.all(held.splice(0));
  assert.equal(calls, 1);
  assert.equal(first.hit, false);
  assert.deepEqual(second.value, { ok: true });
});

test("a read error is a miss: the fetcher still runs", async () => {
  const { held, deps, store } = harness();
  store.failReadsWith(new Error("db is down"));
  let calls = 0;
  const result = await cached(input, async () => {
    calls += 1;
    return { ok: true };
  }, deps);
  assert.equal(result.hit, false);
  assert.equal(calls, 1);
  await Promise.all(held.splice(0));
});

test("workspace scope without a brand is a 500 before any fetch", async () => {
  const { deps } = harness();
  await assert.rejects(
    () =>
      cached(
        { namespace: "qa", version: 1, keyParts: [], ttlSeconds: 600, schema, scope: "workspace" },
        async () => ({ ok: true }),
        deps
      ),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === "cache_scope_invalid"
  );
});
