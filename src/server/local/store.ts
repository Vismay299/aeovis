// F17 persistence seam. Services depend on LocalStore; production uses the
// Supabase service-role implementation below, tests use memoryStore.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import type { CacheDeps } from "../cache/providerCache.ts";
import type { BusinessClient } from "../../shared/providers/dataforseo/business.ts";
import type {
  fetchBusinessDataTaskResult,
  fetchBusinessListingsCategories,
} from "../../shared/providers/dataforseo/business.ts";
import type { createDataforseoClient } from "../../shared/providers/dataforseo/client.ts";
import type { fetchLocalSerpTaskResult } from "../../shared/providers/dataforseo/serp.ts";
import type { appendResearch, findRecentResearch } from "../projectContext/service.ts";

export type BusinessRole = "own" | "competitor";
export type FetchStatus = "processing" | "completed" | "failed";
export type StoredFetchKind = "reviews" | "extended_reviews" | "updates" | "questions";

export type BusinessRow = {
  id: string;
  brand_key: string;
  role: BusinessRole;
  title: string;
  cid: string | null;
  place_id: string | null;
  latitude: number | null;
  longitude: number | null;
  location_code: number | null;
  language_code: string;
  profile: unknown | null;
  profile_fetched_at: string | null;
};

export type SaveBusinessArgs = {
  brandKey: string;
  role: BusinessRole;
  title: string;
  cid?: string | null;
  placeId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationCode?: number | null;
  languageCode?: string | null;
  profile?: unknown | null;
  actor?: string | null;
};

export type FetchRow = {
  id: string;
  brand_key: string;
  request_id: string;
  business_id: string | null;
  kind: StoredFetchKind;
  identifier: Record<string, unknown>;
  params: Record<string, unknown>;
  params_hash: string;
  provider_task_id: string | null;
  status: FetchStatus;
  totals: Record<string, unknown> | null;
  item_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

export type NewFetch = {
  brandKey: string;
  requestId: string;
  businessId: string | null;
  kind: StoredFetchKind;
  identifier: Record<string, unknown>;
  params: Record<string, unknown>;
  paramsHash: string;
  requestedBy: string | null;
};

export type FetchPatch = {
  provider_task_id?: string | null;
  status?: FetchStatus;
  totals?: Record<string, unknown> | null;
  item_count?: number;
  error_code?: string | null;
  error_message?: string | null;
  completed_at?: string | null;
};

export type GridRow = {
  id: string;
  brand_key: string;
  request_id: string;
  business_id: string | null;
  keyword: string;
  center_lat: number;
  center_lng: number;
  grid_size: 3 | 5;
  spacing_km: number;
  zoom: number;
  device: "desktop" | "mobile";
  language_code: string;
  target: Record<string, unknown>;
  params_hash: string;
  task_ids: Array<string | null>;
  status: FetchStatus;
  points: unknown[] | null;
  point_rows: unknown[] | null;
  summary: Record<string, unknown> | null;
  matched: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

export type NewGrid = {
  brandKey: string;
  requestId: string;
  businessId: string | null;
  keyword: string;
  centerLat: number;
  centerLng: number;
  gridSize: 3 | 5;
  spacingKm: number;
  zoom: number;
  device: "desktop" | "mobile";
  languageCode: string;
  target: Record<string, unknown>;
  paramsHash: string;
  requestedBy: string | null;
};

export type GridPatch = {
  task_ids?: Array<string | null>;
  status?: FetchStatus;
  points?: unknown[] | null;
  point_rows?: unknown[] | null;
  summary?: Record<string, unknown> | null;
  matched?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  completed_at?: string | null;
};

export type NewSearch = {
  brandKey: string;
  kind: "local_serp" | "listings";
  params: Record<string, unknown>;
  resultCount: number;
  ownRank: number | null;
  cacheKey: string;
  cached: boolean;
  requestedBy: string | null;
};

export interface LocalStore {
  listBusinesses(brandKey: string): Promise<BusinessRow[]>;
  getBusiness(brandKey: string, id: string): Promise<BusinessRow | null>;
  /** save_local_business: caps, demotion and error mapping included. */
  saveBusiness(args: SaveBusinessArgs): Promise<string>;
  removeBusiness(brandKey: string, id: string): Promise<boolean>;

  findReuse(brandKey: string, table: "fetch" | "grid", hash: string, sinceIso: string): Promise<string | null>;
  claimPoll(brandKey: string, table: "fetch" | "grid", id: string): Promise<boolean>;

  /** ON CONFLICT (request_id) DO NOTHING; returns the existing row when it conflicts. */
  insertFetch(row: NewFetch): Promise<{ row: FetchRow; created: boolean }>;
  getFetch(brandKey: string, id: string): Promise<FetchRow | null>;
  updateFetch(brandKey: string, id: string, patch: FetchPatch): Promise<void>;
  deleteFetch(brandKey: string, id: string): Promise<void>;
  listFetches(brandKey: string, q: { businessId?: string; kind?: StoredFetchKind; limit: number }): Promise<FetchRow[]>;
  upsertFetchItems(brandKey: string, fetchId: string, items: unknown[]): Promise<void>;
  getFetchItems(brandKey: string, fetchId: string): Promise<unknown[]>;

  insertGrid(row: NewGrid): Promise<{ row: GridRow; created: boolean }>;
  getGrid(brandKey: string, id: string): Promise<GridRow | null>;
  updateGrid(brandKey: string, id: string, patch: GridPatch): Promise<void>;
  deleteGrid(brandKey: string, id: string): Promise<void>;
  listGrids(brandKey: string, limit: number): Promise<GridRow[]>;
  countGridsSince(brandKey: string, sinceIso: string): Promise<number>;

  recordSearch(row: NewSearch): Promise<void>;
}

/** Everything the F17 services can be given in tests. All optional. */
export type LocalDeps = {
  store?: LocalStore;
  business?: BusinessClient;
  serp?: Pick<ReturnType<typeof createDataforseoClient>["serp"], "local" | "localTaskPost">;
  fetchTaskResult?: typeof fetchBusinessDataTaskResult;
  fetchSerpTaskResult?: typeof fetchLocalSerpTaskResult;
  fetchCategories?: typeof fetchBusinessListingsCategories;
  cacheDeps?: CacheDeps;
  appendResearch?: typeof appendResearch;
  findRecentResearch?: typeof findRecentResearch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

export const LOCAL_SAVE_FAILED = "Local data could not be saved. Please retry.";
export const LOCAL_UNAVAILABLE_MESSAGE = "Local data could not be loaded. Please retry.";

function unavailable(message = LOCAL_SAVE_FAILED, cause?: unknown): AppError {
  return new AppError(503, "local_unavailable", message, { cause });
}

type PgError = { message?: string; code?: string } | null;

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBusiness(raw: Record<string, unknown>): BusinessRow {
  return {
    ...(raw as unknown as BusinessRow),
    latitude: asNumber(raw.latitude),
    longitude: asNumber(raw.longitude),
  };
}

function normalizeGrid(raw: Record<string, unknown>): GridRow {
  return {
    ...(raw as unknown as GridRow),
    center_lat: Number(raw.center_lat),
    center_lng: Number(raw.center_lng),
    spacing_km: Number(raw.spacing_km),
    grid_size: Number(raw.grid_size) as 3 | 5,
  };
}

/** Maps save_local_business errors (spec 6.1 "Error mapping"). */
export function mapSaveBusinessError(error: NonNullable<PgError>): AppError {
  const message = String(error.message ?? "");
  if (message.includes("local_business_cap:competitors")) {
    return new AppError(409, "competitor_limit", "You can save up to 10 local competitors. Remove one first.");
  }
  if (message.includes("local_business_invalid:")) {
    return new AppError(400, "invalid_request", "Check the business details and try again.");
  }
  return unavailable(LOCAL_SAVE_FAILED, error);
}

export function supabaseLocalStore(admin: SupabaseClient): LocalStore {
  function check(error: PgError, message = LOCAL_UNAVAILABLE_MESSAGE): void {
    if (error) throw unavailable(message, error);
  }

  return {
    async listBusinesses(brandKey) {
      const { data, error } = await admin.from("local_businesses").select("*").eq("brand_key", brandKey);
      check(error);
      return ((data ?? []) as Record<string, unknown>[]).map(normalizeBusiness);
    },

    async getBusiness(brandKey, id) {
      const { data, error } = await admin
        .from("local_businesses")
        .select("*")
        .eq("brand_key", brandKey)
        .eq("id", id)
        .maybeSingle();
      check(error);
      return data ? normalizeBusiness(data as Record<string, unknown>) : null;
    },

    async saveBusiness(a) {
      const args = {
        p_brand: a.brandKey,
        p_role: a.role,
        p_title: a.title,
        p_cid: a.cid ?? null,
        p_place_id: a.placeId ?? null,
        p_lat: a.latitude ?? null,
        p_lng: a.longitude ?? null,
        p_location_code: a.locationCode ?? null,
        p_language: a.languageCode ?? null,
        p_profile: a.profile ?? null,
        p_actor: a.actor ?? null,
      };
      // A concurrent save of the same CID or place ID can lose the unique index race; retry once.
      for (let attempt = 0; ; attempt += 1) {
        const { data, error } = await admin.rpc("save_local_business", args);
        if (!error) return String(data);
        if (error.code === "23505" && attempt === 0) continue;
        throw mapSaveBusinessError(error);
      }
    },

    async removeBusiness(brandKey, id) {
      const { data, error } = await admin
        .from("local_businesses")
        .delete()
        .eq("brand_key", brandKey)
        .eq("id", id)
        .select("id");
      check(error);
      return (data ?? []).length > 0;
    },

    async findReuse(brandKey, table, hash, sinceIso) {
      const { data, error } = await admin.rpc("find_local_reuse", {
        p_brand: brandKey,
        p_table: table,
        p_hash: hash,
        p_since: sinceIso,
      });
      check(error);
      return typeof data === "string" ? data : null;
    },

    async claimPoll(brandKey, table, id) {
      const { data, error } = await admin.rpc("claim_local_poll", {
        p_brand: brandKey,
        p_table: table,
        p_id: id,
        p_min_seconds: 4,
      });
      check(error);
      return data === true;
    },

    async insertFetch(row) {
      const payload = {
        brand_key: row.brandKey,
        request_id: row.requestId,
        business_id: row.businessId,
        kind: row.kind,
        identifier: row.identifier,
        params: row.params,
        params_hash: row.paramsHash,
        requested_by: row.requestedBy,
      };
      const { data, error } = await admin
        .from("local_fetches")
        .upsert(payload, { onConflict: "request_id", ignoreDuplicates: true })
        .select("*");
      check(error);
      const inserted = (data ?? [])[0] as FetchRow | undefined;
      if (inserted) return { row: inserted, created: true };
      const existing = await admin
        .from("local_fetches")
        .select("*")
        .eq("brand_key", row.brandKey)
        .eq("request_id", row.requestId)
        .maybeSingle();
      check(existing.error);
      if (!existing.data) throw unavailable();
      return { row: existing.data as FetchRow, created: false };
    },

    async getFetch(brandKey, id) {
      const { data, error } = await admin
        .from("local_fetches")
        .select("*")
        .eq("brand_key", brandKey)
        .eq("id", id)
        .maybeSingle();
      check(error);
      return (data as FetchRow | null) ?? null;
    },

    async updateFetch(brandKey, id, patch) {
      const { error } = await admin.from("local_fetches").update(patch).eq("brand_key", brandKey).eq("id", id);
      check(error);
    },

    async deleteFetch(brandKey, id) {
      const { error } = await admin.from("local_fetches").delete().eq("brand_key", brandKey).eq("id", id);
      check(error);
    },

    async listFetches(brandKey, q) {
      let query = admin.from("local_fetches").select("*").eq("brand_key", brandKey);
      if (q.businessId) query = query.eq("business_id", q.businessId);
      if (q.kind) query = query.eq("kind", q.kind);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(q.limit);
      check(error);
      return (data ?? []) as FetchRow[];
    },

    async upsertFetchItems(brandKey, fetchId, items) {
      if (items.length === 0) return;
      const { error } = await admin.from("local_fetch_items").upsert(
        items.map((item, idx) => ({ fetch_id: fetchId, brand_key: brandKey, idx, item })),
        { onConflict: "fetch_id,idx" },
      );
      check(error);
    },

    async getFetchItems(brandKey, fetchId) {
      const { data, error } = await admin
        .from("local_fetch_items")
        .select("idx,item")
        .eq("brand_key", brandKey)
        .eq("fetch_id", fetchId)
        .order("idx", { ascending: true });
      check(error);
      return ((data ?? []) as Array<{ item: unknown }>).map((r) => r.item);
    },

    async insertGrid(row) {
      const payload = {
        brand_key: row.brandKey,
        request_id: row.requestId,
        business_id: row.businessId,
        keyword: row.keyword,
        center_lat: row.centerLat,
        center_lng: row.centerLng,
        grid_size: row.gridSize,
        spacing_km: row.spacingKm,
        zoom: row.zoom,
        device: row.device,
        language_code: row.languageCode,
        target: row.target,
        params_hash: row.paramsHash,
        task_ids: [],
        requested_by: row.requestedBy,
      };
      const { data, error } = await admin
        .from("local_grid_runs")
        .upsert(payload, { onConflict: "request_id", ignoreDuplicates: true })
        .select("*");
      check(error);
      const inserted = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (inserted) return { row: normalizeGrid(inserted), created: true };
      const existing = await admin
        .from("local_grid_runs")
        .select("*")
        .eq("brand_key", row.brandKey)
        .eq("request_id", row.requestId)
        .maybeSingle();
      check(existing.error);
      if (!existing.data) throw unavailable();
      return { row: normalizeGrid(existing.data as Record<string, unknown>), created: false };
    },

    async getGrid(brandKey, id) {
      const { data, error } = await admin
        .from("local_grid_runs")
        .select("*")
        .eq("brand_key", brandKey)
        .eq("id", id)
        .maybeSingle();
      check(error);
      return data ? normalizeGrid(data as Record<string, unknown>) : null;
    },

    async updateGrid(brandKey, id, patch) {
      const { error } = await admin.from("local_grid_runs").update(patch).eq("brand_key", brandKey).eq("id", id);
      check(error);
    },

    async deleteGrid(brandKey, id) {
      const { error } = await admin.from("local_grid_runs").delete().eq("brand_key", brandKey).eq("id", id);
      check(error);
    },

    async listGrids(brandKey, limit) {
      const { data, error } = await admin
        .from("local_grid_runs")
        .select("*")
        .eq("brand_key", brandKey)
        .order("created_at", { ascending: false })
        .limit(limit);
      check(error);
      return ((data ?? []) as Record<string, unknown>[]).map(normalizeGrid);
    },

    async countGridsSince(brandKey, sinceIso) {
      const { count, error } = await admin
        .from("local_grid_runs")
        .select("id", { count: "exact", head: true })
        .eq("brand_key", brandKey)
        .gte("created_at", sinceIso);
      check(error);
      return count ?? 0;
    },

    async recordSearch(row) {
      const { error } = await admin.from("local_searches").insert({
        brand_key: row.brandKey,
        kind: row.kind,
        params: row.params,
        result_count: row.resultCount,
        own_rank: row.ownRank,
        cache_key: row.cacheKey,
        cached: row.cached,
        requested_by: row.requestedBy,
      });
      check(error);
    },
  };
}

export function localStoreFor(ws: { admin: SupabaseClient }, deps?: { store?: LocalStore }): LocalStore {
  return deps?.store ?? supabaseLocalStore(ws.admin);
}

/** Log lines carry ids, kinds, counts and codes only (F17 §6.7). */
export function localLog(deps: { log?: (line: string) => void } | undefined, line: string): void {
  (deps?.log ?? ((l: string) => console.log(l)))(line);
}
