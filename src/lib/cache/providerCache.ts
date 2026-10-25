// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/r2-cache.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import { AppError } from "../http/appError.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { keepAlive as defaultKeepAlive } from "../keepAlive.js";
import type { CacheRow, CacheStore } from "./store.ts";
import { createCacheStore } from "./store.ts";

export const CACHE_INLINE_MAX_BYTES = 262_144;

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 2_592_000;

export type CacheScope = "workspace" | "global";

export type CacheDeps = {
  store?: CacheStore;
  keepAlive?: typeof defaultKeepAlive;
  now?: () => number;
  logger?: Pick<Console, "warn" | "error">;
};

// Sorted object keys, recursive, arrays keep order. Every value a key part can
// hold has to render distinctly: `Object.entries(new Date())` is empty, so a
// plain-object walk renders every Date, Map and Set as "{}" and two key parts
// that differ only in their date hash to the SAME key — a cache hit returning
// another request's payload. The exotic types are therefore named here, and a
// type that is none of them and carries no own keys throws rather than
// collapsing into "{}".
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(`@bigint:${value.toString()}`) as string;
  if (typeof value === "function" || typeof value === "symbol") {
    throw new AppError(500, "cache_key_invalid", "A cache key part cannot be serialised.");
  }
  if (typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return "[" + value.map((entry) => stableStringify(entry)).join(",") + "]";
  if (value instanceof Date) {
    const time = value.getTime();
    return JSON.stringify(`@date:${Number.isNaN(time) ? "invalid" : value.toISOString()}`) as string;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, entry]) => stableStringify(key) + ":" + stableStringify(entry))
      .sort();
    return "@map{" + entries.join(",") + "}";
  }
  if (value instanceof Set) {
    return "@set[" + [...value].map((entry) => stableStringify(entry)).sort().join(",") + "]";
  }
  if (value instanceof RegExp) return JSON.stringify(`@regexp:${value.source}/${value.flags}`) as string;
  if (value instanceof URL) return JSON.stringify(`@url:${value.toString()}`) as string;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) {
    const proto = Object.getPrototypeOf(value as object);
    if (proto !== Object.prototype && proto !== null) {
      throw new AppError(500, "cache_key_invalid", "A cache key part cannot be serialised.");
    }
  }
  return "{" + entries.map(([key, entry]) => JSON.stringify(key) + ":" + stableStringify(entry)).join(",") + "}";
}

export function cacheKey(i: {
  namespace: string;
  version: number;
  keyParts: unknown[];
  scope: CacheScope;
  brandKey?: string;
}): string {
  if (i.scope === "workspace" && !i.brandKey) {
    throw new AppError(500, "cache_scope_invalid", "A workspace cache key needs a brand.");
  }
  const scopedBrand = i.scope === "workspace" ? (i.brandKey as string) : "";
  const raw = stableStringify([i.namespace, i.version, i.keyParts, scopedBrand]);
  return createHash("sha256").update(raw).digest("hex");
}

function storeFor(deps?: CacheDeps): CacheStore | null {
  if (deps?.store) return deps.store;
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  return createCacheStore(admin);
}

type FlightResult = { value: unknown; fetchedAt: string };

const singleFlight = new Map<string, Promise<FlightResult>>();

// A row read from Storage that could not be fetched is a miss, which a plain
// `null` cannot say: a body of "null" is a cached value, and the two must not
// render as the same thing.
const MISSING = Symbol("cache-missing");

export async function cached<T>(
  i: {
    namespace: string;
    version: number;
    keyParts: unknown[];
    ttlSeconds: number;
    schema: ZodType<T>;
    scope: CacheScope;
    brandKey?: string;
  },
  fetcher: () => Promise<T>,
  deps?: CacheDeps
): Promise<{ value: T; hit: boolean; fetchedAt: string }> {
  if (!Number.isInteger(i.ttlSeconds) || i.ttlSeconds < MIN_TTL_SECONDS || i.ttlSeconds > MAX_TTL_SECONDS) {
    throw new AppError(500, "cache_ttl_invalid", "The cache TTL is out of range.");
  }
  const key = cacheKey(i);
  const logger = deps?.logger ?? console;
  const nowMs = (deps?.now ?? Date.now)();
  const store = storeFor(deps);

  if (store) {
    let row: CacheRow | null = null;
    try {
      row = await store.read(key);
    } catch {
      row = null;
    }
    if (row && Date.parse(row.expiresAt) > nowMs) {
      let record: unknown = row.storagePath ? MISSING : row.value;
      if (row.storagePath) {
        try {
          const body = await store.readBody(row.storagePath);
          record = body === null ? MISSING : JSON.parse(body);
        } catch {
          record = MISSING;
        }
      }
      if (record !== MISSING) {
        const parsed = i.schema.safeParse(record);
        if (parsed.success) {
          return { value: parsed.data, hit: true, fetchedAt: row.fetchedAt };
        }
        logger.warn("[cache] schema mismatch", { namespace: i.namespace, version: i.version });
      }
    } else if (row) {
      const parsed = i.schema.safeParse(row.value);
      if (!parsed.success && row.value !== null && !row.storagePath) {
        logger.warn("[cache] schema mismatch", { namespace: i.namespace, version: i.version });
      }
    }
  }

  const running = singleFlight.get(key);
  if (running) {
    // Piggybacking on the in-flight fetch: the value is fresh from the fetcher,
    // not from the cache, so it reports `hit: false` and the fetch's own
    // fetchedAt rather than a timestamp taken before the fetch finished.
    const shared = await running;
    return { value: shared.value as T, hit: false, fetchedAt: shared.fetchedAt };
  }

  const work = (async (): Promise<FlightResult> => {
    const fresh = await fetcher();
    const parsed = i.schema.safeParse(fresh);
    if (!parsed.success) {
      throw new AppError(500, "cache_fetcher_invalid", "The fetcher returned a value that fails the cache schema.");
    }
    const value = parsed.data;
    const fetchedAt = new Date((deps?.now ?? Date.now)()).toISOString();
    const target = storeFor(deps);
    if (target) {
      const keepAlive = deps?.keepAlive ?? defaultKeepAlive;
      const text = JSON.stringify(value);
      const bytes = new TextEncoder().encode(text).length;
      // `provider_cache_one_body` is `(value IS NULL) <> (storage_path IS NULL)`,
      // so a cached JSON null cannot live in the row: it would write NULL into
      // both columns, the upsert would be refused, and the keepAlive wrapper
      // would swallow it — the namespace silently never caching. A null body
      // goes to Storage, where it round-trips as the value it is.
      const write =
        bytes > CACHE_INLINE_MAX_BYTES || value === null
          ? (async () => {
              const storagePath = `provider-cache/${i.namespace}/${key}.json`;
              await target.writeBody(storagePath, text);
              await target.write({
                key,
                namespace: i.namespace,
                version: i.version,
                scope: i.scope,
                brandKey: i.scope === "workspace" ? (i.brandKey as string) : null,
                value: null,
                storagePath,
                sizeBytes: bytes,
                fetchedAt,
                expiresAt: new Date(Date.parse(fetchedAt) + i.ttlSeconds * 1000).toISOString(),
              });
            })()
          : target.write({
              key,
              namespace: i.namespace,
              version: i.version,
              scope: i.scope,
              brandKey: i.scope === "workspace" ? (i.brandKey as string) : null,
              value: value as unknown,
              storagePath: null,
              sizeBytes: bytes,
              fetchedAt,
              expiresAt: new Date(Date.parse(fetchedAt) + i.ttlSeconds * 1000).toISOString(),
            });
      keepAlive(
        write.then(
          () => undefined,
          () => {
            logger.warn("[cache] write failed", { namespace: i.namespace });
          }
        ),
        { label: "cache:write" }
      );
    }
    return { value, fetchedAt };
  })();

  singleFlight.set(key, work);
  try {
    const fresh = await work;
    return { value: fresh.value as T, hit: false, fetchedAt: fresh.fetchedAt };
  } finally {
    singleFlight.delete(key);
  }
}

export { stableStringify };
