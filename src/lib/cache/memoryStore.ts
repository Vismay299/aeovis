import type { CacheRow, CacheStore } from "./store.ts";

type MemoryCacheSeed = { now?: () => number };

export type MemoryCacheStore = CacheStore & {
  rows: Map<string, CacheRow>;
  bodies: Map<string, string>;
  readError: Error | null;
  failReadsWith(error: Error | null): void;
};

export function createMemoryCacheStore(seed: MemoryCacheSeed = {}): MemoryCacheStore {
  const now = seed.now ?? Date.now;
  const rows = new Map<string, CacheRow>();
  const bodies = new Map<string, string>();
  let readError: Error | null = null;

  return {
    rows,
    bodies,
    get readError() {
      return readError;
    },
    failReadsWith(error: Error | null) {
      readError = error;
    },
    async read(key) {
      if (readError) throw readError;
      return rows.get(key) ?? null;
    },
    async write(row) {
      if (readError) throw readError;
      rows.set(row.key, { ...row });
    },
    async readBody(storagePath) {
      if (readError) throw readError;
      return bodies.get(storagePath) ?? null;
    },
    async writeBody(storagePath, body) {
      if (readError) throw readError;
      bodies.set(storagePath, body);
    },
    async removeBodies(storagePaths) {
      if (readError) throw readError;
      for (const path of storagePaths) bodies.delete(path);
    },
    async pruneExpired(before, limit) {
      if (readError) throw readError;
      const cutoff = before.getTime();
      const expired = [...rows.values()]
        .filter((row) => Date.parse(row.expiresAt) < cutoff)
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
        .slice(0, limit);
      void now;
      const paths: string[] = [];
      for (const row of expired) {
        rows.delete(row.key);
        if (row.storagePath) {
          bodies.delete(row.storagePath);
          paths.push(row.storagePath);
        }
      }
      return paths;
    },
  };
}
