import type { SupabaseClient } from "@supabase/supabase-js";

export type CacheRow = {
  key: string;
  namespace: string;
  version: number;
  scope: "workspace" | "global";
  brandKey: string | null;
  value: unknown;
  storagePath: string | null;
  sizeBytes: number;
  fetchedAt: string;
  expiresAt: string;
};

/** `deleted` is every pruned row; `paths` only the storage-backed subset. */
export type CachePruneResult = { deleted: number; paths: string[] };

export type CacheStore = {
  read(key: string): Promise<CacheRow | null>;
  write(row: CacheRow): Promise<void>;
  readBody(storagePath: string): Promise<string | null>;
  writeBody(storagePath: string, body: string): Promise<void>;
  removeBodies(storagePaths: string[]): Promise<void>;
  pruneExpired(before: Date, limit: number): Promise<CachePruneResult>;
};

function toRow(data: Record<string, unknown> | null): CacheRow | null {
  if (!data || typeof data.key !== "string") return null;
  return {
    key: data.key,
    namespace: typeof data.namespace === "string" ? data.namespace : "",
    version: typeof data.version === "number" ? data.version : 0,
    scope: data.scope === "workspace" ? "workspace" : "global",
    brandKey: typeof data.brand_key === "string" ? data.brand_key : null,
    value: (data as { value?: unknown }).value ?? null,
    storagePath: typeof data.storage_path === "string" ? data.storage_path : null,
    sizeBytes: typeof data.size_bytes === "number" ? data.size_bytes : 0,
    fetchedAt: typeof data.fetched_at === "string" ? data.fetched_at : new Date().toISOString(),
    expiresAt: typeof data.expires_at === "string" ? data.expires_at : new Date().toISOString(),
  };
}

export const PROVIDER_CACHE_BUCKET = "provider-cache";

export function createCacheStore(admin: SupabaseClient): CacheStore {
  const bucket = () => admin.storage.from(PROVIDER_CACHE_BUCKET);
  return {
    async read(key) {
      const { data, error } = await admin.from("provider_cache").select("*").eq("key", key).maybeSingle();
      if (error) throw new Error(error.message);
      return toRow((data ?? null) as Record<string, unknown> | null);
    },

    async write(row) {
      const { error } = await admin.from("provider_cache").upsert(
        {
          key: row.key,
          namespace: row.namespace,
          version: row.version,
          scope: row.scope,
          brand_key: row.brandKey,
          value: row.storagePath === null ? (row.value as Record<string, unknown> | null) : null,
          storage_path: row.storagePath,
          size_bytes: row.sizeBytes,
          fetched_at: row.fetchedAt,
          expires_at: row.expiresAt,
        },
        { onConflict: "key" }
      );
      if (error) throw new Error(error.message);
    },

    async readBody(storagePath) {
      const { data, error } = await bucket().download(storagePath);
      if (error) throw new Error(error.message);
      if (!data) return null;
      return await data.text();
    },

    async writeBody(storagePath, body) {
      const { error } = await bucket().upload(storagePath, body, {
        contentType: "application/json",
        upsert: true,
      });
      if (error) throw new Error(error.message);
    },

    async removeBodies(storagePaths) {
      for (let index = 0; index < storagePaths.length; index += 100) {
        const batch = storagePaths.slice(index, index + 100);
        if (batch.length === 0) continue;
        const { error } = await bucket().remove(batch);
        if (error) throw new Error(error.message);
      }
    },

    async pruneExpired(before, limit) {
      const { data, error } = await admin.rpc("prune_provider_cache", {
        p_expired_before: before.toISOString(),
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      if (!Array.isArray(data)) return { deleted: 0, paths: [] };
      // One row per deleted cache row; `storage_path` is NULL for inline
      // bodies, so the count has to come from the rows, not the paths.
      return {
        deleted: data.length,
        paths: data.filter((path): path is string => typeof path === "string" && path.length > 0),
      };
    },
  };
}
