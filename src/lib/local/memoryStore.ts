// In-memory LocalStore for tests and route fixtures. Mirrors the SQL contract of
// migrations 120 and 121: one own business, ten competitors, a one-hour reuse
// window that ignores failed rows, request_id uniqueness and the poll throttle.

import { randomUUID } from "node:crypto";
import { AppError } from "../http/appError.ts";
import type {
  BusinessRow,
  FetchRow,
  FetchStatus,
  GridRow,
  LocalStore,
  NewSearch,
} from "./store.ts";

export type MemoryLocalStore = LocalStore & {
  businesses: Map<string, BusinessRow>;
  fetches: Map<string, FetchRow>;
  fetchItems: Map<string, unknown[]>;
  grids: Map<string, GridRow>;
  searches: NewSearch[];
  /** Number of provider-poll claims granted. */
  claims: { fetch: number; grid: number };
};

export function createMemoryLocalStore(opts: { now?: () => number } = {}): MemoryLocalStore {
  const now = opts.now ?? Date.now;
  const businesses = new Map<string, BusinessRow>();
  const fetches = new Map<string, FetchRow>();
  const fetchItems = new Map<string, unknown[]>();
  const grids = new Map<string, GridRow>();
  const searches: NewSearch[] = [];
  const polledAt = new Map<string, number>();
  const claims = { fetch: 0, grid: 0 };
  const iso = () => new Date(now()).toISOString();

  const forBrand = <T extends { brand_key: string }>(rows: Iterable<T>, brandKey: string) =>
    [...rows].filter((r) => r.brand_key === brandKey);

  return {
    businesses,
    fetches,
    fetchItems,
    grids,
    searches,
    claims,

    async listBusinesses(brandKey) {
      return forBrand(businesses.values(), brandKey).map((b) => ({ ...b }));
    },
    async getBusiness(brandKey, id) {
      const b = businesses.get(id);
      return b && b.brand_key === brandKey ? { ...b } : null;
    },
    async saveBusiness(a) {
      if (a.role !== "own" && a.role !== "competitor") {
        throw new AppError(400, "invalid_request", "Check the business details and try again.");
      }
      // Like the SQL function, a refused save leaves every row unchanged (the exception rolls back).
      const snapshot = new Map([...businesses].map(([id, row]) => [id, { ...row }]));
      try {
        const mine = forBrand(businesses.values(), a.brandKey);
        const existing = mine.find(
          (b) => (a.cid != null && b.cid === a.cid) || (a.placeId != null && b.place_id === a.placeId),
        );
        if (a.role === "own") {
          for (const b of mine) if (b.role === "own" && b.id !== existing?.id) b.role = "competitor";
        }
        const competitors = () =>
          forBrand(businesses.values(), a.brandKey).filter((b) => b.role === "competitor").length;
        const tooMany = () =>
          new AppError(409, "competitor_limit", "You can save up to 10 local competitors. Remove one first.");
        let id: string;
        if (!existing) {
          if (a.role === "competitor" && competitors() >= 10) throw tooMany();
          const row: BusinessRow = {
            id: randomUUID(),
            brand_key: a.brandKey,
            role: a.role,
            title: a.title,
            cid: a.cid ?? null,
            place_id: a.placeId ?? null,
            latitude: a.latitude ?? null,
            longitude: a.longitude ?? null,
            location_code: a.locationCode ?? null,
            language_code: a.languageCode ?? "en",
            profile: a.profile ?? null,
            profile_fetched_at: a.profile ? iso() : null,
          };
          businesses.set(row.id, row);
          id = row.id;
        } else {
          existing.role = a.role;
          existing.title = a.title;
          existing.cid = a.cid ?? existing.cid;
          existing.place_id = a.placeId ?? existing.place_id;
          existing.latitude = a.latitude ?? existing.latitude;
          existing.longitude = a.longitude ?? existing.longitude;
          existing.location_code = a.locationCode ?? existing.location_code;
          if (a.profile) {
            existing.profile = a.profile;
            existing.profile_fetched_at = iso();
          }
          id = existing.id;
        }
        // Final cap check: an own-business demotion above also adds a competitor.
        if (competitors() > 10) throw tooMany();
        return id;
      } catch (err) {
        businesses.clear();
        for (const [id, row] of snapshot) businesses.set(id, row);
        throw err;
      }
    },
    async removeBusiness(brandKey, id) {
      const b = businesses.get(id);
      if (!b || b.brand_key !== brandKey) return false;
      businesses.delete(id);
      for (const f of fetches.values()) if (f.business_id === id) f.business_id = null;
      for (const g of grids.values()) if (g.business_id === id) g.business_id = null;
      return true;
    },

    async findReuse(brandKey, table, hash, sinceIso) {
      const since = Date.parse(sinceIso);
      const rows: Array<FetchRow | GridRow> = table === "fetch" ? [...fetches.values()] : [...grids.values()];
      const hit = rows
        .filter(
          (r) =>
            r.brand_key === brandKey &&
            r.params_hash === hash &&
            Date.parse(r.created_at) >= since &&
            (r.status === "processing" || r.status === "completed"),
        )
        .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0];
      return hit?.id ?? null;
    },
    async claimPoll(brandKey, table, id) {
      const row = table === "fetch" ? fetches.get(id) : grids.get(id);
      if (!row || row.brand_key !== brandKey || row.status !== "processing") return false;
      const key = `${table}:${id}`;
      const last = polledAt.get(key);
      if (last !== undefined && last > now() - 4000) return false;
      polledAt.set(key, now());
      claims[table] += 1;
      return true;
    },

    async insertFetch(r) {
      const dup = [...fetches.values()].find((f) => f.request_id === r.requestId);
      if (dup) return { row: { ...dup }, created: false };
      const row: FetchRow = {
        id: randomUUID(),
        brand_key: r.brandKey,
        request_id: r.requestId,
        business_id: r.businessId,
        kind: r.kind,
        identifier: r.identifier,
        params: r.params,
        params_hash: r.paramsHash,
        provider_task_id: null,
        status: "processing",
        totals: null,
        item_count: 0,
        error_code: null,
        error_message: null,
        created_at: iso(),
        completed_at: null,
      };
      fetches.set(row.id, row);
      return { row: { ...row }, created: true };
    },
    async getFetch(brandKey, id) {
      const f = fetches.get(id);
      return f && f.brand_key === brandKey ? { ...f } : null;
    },
    async updateFetch(brandKey, id, patch) {
      const f = fetches.get(id);
      if (f && f.brand_key === brandKey) Object.assign(f, patch);
    },
    async deleteFetch(brandKey, id) {
      const f = fetches.get(id);
      if (f && f.brand_key === brandKey) {
        fetches.delete(id);
        fetchItems.delete(id);
      }
    },
    async listFetches(brandKey, q) {
      return forBrand(fetches.values(), brandKey)
        .filter((f) => (!q.businessId || f.business_id === q.businessId) && (!q.kind || f.kind === q.kind))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, q.limit)
        .map((f) => ({ ...f }));
    },
    async upsertFetchItems(_brandKey, fetchId, items) {
      const current = [...(fetchItems.get(fetchId) ?? [])];
      items.forEach((item, idx) => {
        current[idx] = item;
      });
      fetchItems.set(fetchId, current);
    },
    async getFetchItems(brandKey, fetchId) {
      const f = fetches.get(fetchId);
      return f && f.brand_key === brandKey ? [...(fetchItems.get(fetchId) ?? [])] : [];
    },

    async insertGrid(r) {
      const dup = [...grids.values()].find((g) => g.request_id === r.requestId);
      if (dup) return { row: { ...dup }, created: false };
      const row: GridRow = {
        id: randomUUID(),
        brand_key: r.brandKey,
        request_id: r.requestId,
        business_id: r.businessId,
        keyword: r.keyword,
        center_lat: r.centerLat,
        center_lng: r.centerLng,
        grid_size: r.gridSize,
        spacing_km: r.spacingKm,
        zoom: r.zoom,
        device: r.device,
        language_code: r.languageCode,
        target: r.target,
        params_hash: r.paramsHash,
        task_ids: [],
        status: "processing" as FetchStatus,
        points: null,
        point_rows: null,
        summary: null,
        matched: null,
        error_code: null,
        error_message: null,
        created_at: iso(),
        completed_at: null,
      };
      grids.set(row.id, row);
      return { row: { ...row }, created: true };
    },
    async getGrid(brandKey, id) {
      const g = grids.get(id);
      return g && g.brand_key === brandKey ? { ...g } : null;
    },
    async updateGrid(brandKey, id, patch) {
      const g = grids.get(id);
      if (g && g.brand_key === brandKey) Object.assign(g, patch);
    },
    async deleteGrid(brandKey, id) {
      const g = grids.get(id);
      if (g && g.brand_key === brandKey) grids.delete(id);
    },
    async listGrids(brandKey, limit) {
      return forBrand(grids.values(), brandKey)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, limit)
        .map((g) => ({ ...g }));
    },
    async countGridsSince(brandKey, sinceIso) {
      const since = Date.parse(sinceIso);
      return forBrand(grids.values(), brandKey).filter((g) => Date.parse(g.created_at) >= since).length;
    },

    async recordSearch(row) {
      searches.push(row);
    },
  };
}
