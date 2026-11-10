// PATTERN of serp.ts:94-137, DomainService.ts:66-117
// See THIRD_PARTY_NOTICES.md.

import { cached, type CacheDeps } from "../cache/providerCache.ts";

export type CachedInput<T> = Parameters<typeof cached<T>>[0];

export class CacheOnlyMiss extends Error {
  constructor(message = "Cache miss in cache-only mode") {
    super(message);
    this.name = "CacheOnlyMiss";
  }
}

class SkipCache<T> extends Error {
  readonly value: T;
  constructor(value: T) {
    super("SkipCache");
    this.name = "SkipCache";
    this.value = value;
  }
}

export async function peekCached<T>(
  i: CachedInput<T>,
  deps?: { cached?: typeof cached; cacheDeps?: CacheDeps },
): Promise<{ value: T; fetchedAt: string } | null> {
  const cachedFn = deps?.cached ?? cached;
  try {
    const res = await cachedFn(
      i,
      () => Promise.reject(new CacheOnlyMiss()),
      deps?.cacheDeps,
    );
    return { value: res.value, fetchedAt: res.fetchedAt };
  } catch (err) {
    if (err instanceof CacheOnlyMiss) {
      return null;
    }
    throw err;
  }
}

export async function cachedIf<T>(
  i: CachedInput<T>,
  fetcher: () => Promise<T>,
  keep: (v: T) => boolean,
  deps?: { cached?: typeof cached; cacheDeps?: CacheDeps },
): Promise<{ value: T; hit: boolean; fetchedAt: string }> {
  const cachedFn = deps?.cached ?? cached;
  try {
    return await cachedFn(
      i,
      async () => {
        const value = await fetcher();
        if (!keep(value)) {
          throw new SkipCache(value);
        }
        return value;
      },
      deps?.cacheDeps,
    );
  } catch (err) {
    if (err instanceof SkipCache) {
      const nowMs = deps?.cacheDeps?.now?.() ?? Date.now();
      return {
        value: err.value as T,
        hit: false,
        fetchedAt: new Date(nowMs).toISOString(),
      };
    }
    throw err;
  }
}
