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

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return "[" + value.map((entry) => stableStringify(entry)).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

const singleFlight = new Map<string, Promise<unknown>>();

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
      let record: unknown = row.value;
      if (row.storagePath) {
        try {
          const body = await store.readBody(row.storagePath);
          record = body === null ? null : JSON.parse(body);
        } catch {
          record = null;
        }
      }
      const parsed = i.schema.safeParse(record);
      if (parsed.success && record !== null) {
        return { value: parsed.data, hit: true, fetchedAt: row.fetchedAt };
      }
      if (record !== null) {
        logger.warn("[cache] schema mismatch", { namespace: i.namespace, version: i.version });
      }
    } else if (row) {
      const parsed = i.schema.safeParse(row.value);
      if (!parsed.success && row.value !== null && !row.storagePath) {
        logger.warn("[cache] schema mismatch", { namespace: i.namespace, version: i.version });
      }
    }
  }

  const running = singleFlight.get(key) as Promise<T> | undefined;
  if (running) {
    const value = await running;
    return { value, hit: true, fetchedAt: new Date(nowMs).toISOString() };
  }

  const work = (async (): Promise<T> => {
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
      const write =
        bytes > CACHE_INLINE_MAX_BYTES
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
    return value;
  })();

  singleFlight.set(key, work);
  try {
    const value = await work;
    return { value, hit: false, fetchedAt: new Date((deps?.now ?? Date.now)()).toISOString() };
  } finally {
    singleFlight.delete(key);
  }
}

export { stableStringify };
