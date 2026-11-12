// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/repositories/RankTrackingRepository.ts,
//   src/server/features/rank-tracking/repositories/runQueries.ts,
//   src/server/features/rank-tracking/repositories/snapshotQueries.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";

export type RankConfig = {
  id: string; brand_key: string; domain: string; location_code: number; language_code: string;
  location_name: string | null; devices: "both" | "desktop" | "mobile"; serp_depth: number;
  schedule_interval: "daily" | "weekly" | "monthly" | "manual"; is_active: boolean;
  last_checked_at: string | null; next_check_at: string | null; last_skip_reason: string | null;
  last_skip_at: string | null; approved_max_usd: number | null; approval_id: string | null;
  created_by: string | null; created_at: string; updated_at: string;
};
export type RankConfigInsert = Omit<RankConfig, "id" | "created_at" | "updated_at"> & Partial<Pick<RankConfig, "id" | "created_at" | "updated_at">>;
export type RankConfigPatch = Omit<Partial<RankConfig>, "id" | "brand_key" | "created_at">;
export type RankKeyword = {
  id: string; brand_key: string; config_id: string; keyword: string; match_case: boolean;
  search_volume: number | null; keyword_difficulty: number | null; cpc: number | null;
  metrics_fetched_at: string | null; metrics_source: string | null; pinned_at: string | null; created_at: string;
};
export type RankKeywordInsert = Partial<RankKeyword> & Pick<RankKeyword, "keyword">;
export type RankKeywordPatch = Pick<Partial<RankKeyword>, "search_volume" | "keyword_difficulty" | "cpc" | "metrics_fetched_at" | "metrics_source">;
export type RankRun = {
  id: string; brand_key: string; config_id: string; job_id: string | null; trigger: "manual" | "scheduled";
  method: "live" | "queued"; status: "pending" | "running" | "completed" | "failed";
  phase: "checking" | "rechecking" | "finishing" | null; domain: string; location_code: number;
  language_code: string; location_name: string | null; devices: "both" | "desktop" | "mobile";
  serp_depth: number; keyword_ids: string[]; is_subset_run: boolean; keywords_total: number;
  keywords_checked: number; approved_max_usd: number; reserved_usd: number; error_code: string | null;
  error_message: string | null; created_by: string | null; started_at: string; completed_at: string | null;
};
export type RankRunInsert = Pick<RankRun, "id" | "brand_key" | "config_id" | "trigger" | "method" | "approved_max_usd" | "keyword_ids" | "created_by"> & { job_id?: string | null };
export type RankRunPatch = Pick<Partial<RankRun>, "job_id" | "status" | "phase" | "keywords_total" | "keywords_checked" | "error_code" | "error_message" | "completed_at">;
export type RankSnapshot = {
  id?: number; brand_key: string; run_id: string; tracking_keyword_id: string; keyword: string;
  device: "desktop" | "mobile"; position: number | null; url: string | null; serp_features: string[]; checked_at?: string;
};
export type RankTask = {
  id?: number; brand_key: string; run_id: string; round: number; tracking_keyword_id: string; keyword: string;
  device: "desktop" | "mobile"; state: "planned" | "posted" | "rejected" | "completed" | "failed" | "expired";
  provider_task_id?: string | null; position?: number | null; url?: string | null; serp_features?: string[];
  message?: string | null; created_at?: string; updated_at?: string;
};
export type RankTaskPatch = Pick<Partial<RankTask>, "state" | "provider_task_id" | "position" | "url" | "serp_features" | "message" | "updated_at">;
export type RankSummary = {
  id: string;
  domain: string;
  location_code: number;
  language_code: string;
  location_name: string | null;
  devices: RankConfig["devices"];
  serp_depth: number;
  schedule_interval: RankConfig["schedule_interval"];
  next_check_at: string | null;
  last_checked_at: string | null;
  last_skip_reason: string | null;
  last_skip_at: string | null;
  approved_max_usd: number | null;
  created_at: string;
  keyword_count: number;
  last_run_status: RankRun["status"] | null;
  last_run_completed_at: string | null;
};
export type RankTrendPoint = {
  run_id: string; checked_at: string; keywords_total: number; total: number;
  top3: number; top4to10: number; top11to20: number; ai_overview: number;
};
export type RankMatrixCell = { run_id: string; checked_at: string; tracking_keyword_id: string | null; position: number | null };
export type RankKeywordHistoryPoint = { device: "desktop" | "mobile"; checked_at: string; position: number | null };

export type RankTrackingRepository = {
  listSummaries(brandKey: string): Promise<RankSummary[]>;
  getConfig(brandKey: string, configId: string): Promise<RankConfig | null>;
  findConfigByMarket(brandKey: string, domain: string, locationCode: number, languageCode: string, locationName: string | null): Promise<RankConfig | null>;
  countActiveConfigs(brandKey: string): Promise<number>;
  insertConfig(row: RankConfigInsert): Promise<RankConfig>;
  updateConfig(brandKey: string, configId: string, patch: RankConfigPatch): Promise<RankConfig | null>;
  listDueConfigs(now: string, limit?: number): Promise<RankConfig[]>;
  claimConfig(brandKey: string, configId: string, observed: string, next: string, skip?: { reason: string | null }): Promise<boolean>;
  listKeywords(brandKey: string, configId: string): Promise<RankKeyword[]>;
  keywordCounts(brandKey: string, configIds: string[]): Promise<Map<string, number>>;
  addKeywords(brandKey: string, configId: string, rows: RankKeywordInsert[]): Promise<string[]>;
  removeKeywords(brandKey: string, configId: string, ids: string[]): Promise<number>;
  setPinned(brandKey: string, configId: string, ids: string[], pinned: boolean): Promise<number>;
  updateKeywordMetrics(brandKey: string, rows: Array<RankKeywordPatch & Pick<RankKeyword, "id">>): Promise<void>;
  tryCreateRun(input: RankRunInsert): Promise<boolean>;
  getRun(brandKey: string, runId: string): Promise<RankRun | null>;
  getLatestRun(brandKey: string, configId: string): Promise<RankRun | null>;
  getActiveRun(brandKey: string, configId: string): Promise<RankRun | null>;
  updateRun(brandKey: string, runId: string, patch: RankRunPatch): Promise<RankRun | null>;
  setRunErrorIfEmpty(brandKey: string, runId: string, code: string, message: string): Promise<void>;
  reserve(brandKey: string, runId: string, usd: number): Promise<boolean>;
  insertSnapshots(rows: RankSnapshot[]): Promise<void>;
  upsertSnapshots(rows: RankSnapshot[]): Promise<void>;
  deleteNotFoundSnapshots(brandKey: string, keys: Array<{ runId: string; trackingKeywordId: string; device: "desktop" | "mobile" }>): Promise<number>;
  snapshotsForRun(brandKey: string, runId: string): Promise<RankSnapshot[]>;
  latestSnapshots(brandKey: string, configId: string, before?: string): Promise<Array<RankSnapshot & { keyword: string }>>;
  earliestSnapshots(brandKey: string, configId: string, ids: string[]): Promise<Array<Pick<RankSnapshot, "tracking_keyword_id" | "device" | "position" | "checked_at">>>;
  bestPositions(brandKey: string, configId: string): Promise<Array<{ tracking_keyword_id: string; position: number }>>;
  keywordHistory(brandKey: string, configId: string, keywordId: string, since: string): Promise<RankKeywordHistoryPoint[]>;
  configTrend(brandKey: string, configId: string, device: "desktop" | "mobile", since: string): Promise<RankTrendPoint[]>;
  positionMatrix(brandKey: string, configId: string, device: "desktop" | "mobile", runLimit: number): Promise<RankMatrixCell[]>;
  insertTasks(rows: RankTask[]): Promise<void>;
  tasksByState(brandKey: string, runId: string, round: number, states: RankTask["state"][], limit: number, afterId?: number): Promise<RankTask[]>;
  updateTasks(rows: Array<RankTaskPatch & Pick<RankTask, "id" | "brand_key" | "run_id">>): Promise<void>;
  expireTasks(brandKey: string, runId: string, round: number): Promise<number>;
  prune(runsBefore: string, tasksBefore: string, limit: number): Promise<{ runs: number; tasks: number }>;
};

type DbError = { message?: string; code?: string } | null;
function data<T>(result: { data: unknown; error: DbError }): T {
  if (result.error) throw mapRepositoryError(result.error);
  return result.data as T;
}

export function mapRepositoryError(error: { message?: string; code?: string }): AppError {
  const message = error.message ?? "";
  if (message.includes("rank_config_not_found")) {
    return new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  }
  const cap = message.match(/rank_keywords_cap:(\d+)/);
  if (cap) return new AppError(409, "keyword_limit", "A domain can track up to 1,000 keywords. Remove some first.");
  return new AppError(503, "rank_tracking_unavailable", "Rank tracking could not be saved. Please retry.");
}

// PostgREST caps every response at max_rows (1000 on hosted Supabase). A run holds up to
// 1,000 keywords x 2 devices, so reads that can exceed that page until a short page.
const PAGE_SIZE = 1000;
async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: DbError }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = data<T[] | null>(await fetchPage(from, from + PAGE_SIZE - 1)) ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function chunks<T>(items: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export function createRankTrackingRepository(admin: SupabaseClient): RankTrackingRepository {
  return {
    async listSummaries(brandKey) {
      const result = await admin.rpc("rank_config_summaries", { p_brand: brandKey });
      return data<RankSummary[]>(result);
    },
    async getConfig(brandKey, configId) {
      const result = await admin.from("rank_tracking_configs").select("*").eq("brand_key", brandKey).eq("id", configId).maybeSingle();
      return data<RankConfig | null>(result);
    },
    async findConfigByMarket(brandKey, domain, locationCode, languageCode, locationName) {
      let query = admin.from("rank_tracking_configs").select("*").eq("brand_key", brandKey).eq("domain", domain).eq("location_code", locationCode).eq("language_code", languageCode);
      query = locationName === null ? query.is("location_name", null) : query.eq("location_name", locationName);
      return data<RankConfig | null>(await query.maybeSingle());
    },
    async countActiveConfigs(brandKey) {
      const result = await admin.from("rank_tracking_configs").select("id", { count: "exact", head: true }).eq("brand_key", brandKey).eq("is_active", true);
      if (result.error) throw mapRepositoryError(result.error);
      return result.count ?? 0;
    },
    async insertConfig(row) {
      return data<RankConfig>(await admin.from("rank_tracking_configs").insert(row).select("*").single());
    },
    async updateConfig(brandKey, configId, patch) {
      return data<RankConfig | null>(await admin.from("rank_tracking_configs").update(patch).eq("brand_key", brandKey).eq("id", configId).select("*").maybeSingle());
    },
    async listDueConfigs(now, limit = 500) {
      const query = admin.from("rank_tracking_configs").select("*, customer_brands!inner(is_active)").eq("is_active", true)
        .neq("schedule_interval", "manual").lte("next_check_at", now).eq("customer_brands.is_active", true)
        .order("next_check_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
      return data<RankConfig[]>(await query);
    },
    async claimConfig(brandKey, configId, observed, next, skip) {
      return data<boolean>(await admin.rpc("claim_rank_config", {
        p_brand: brandKey, p_config: configId, p_observed: observed, p_next: next,
        p_write_skip: skip !== undefined, p_skip_reason: skip?.reason ?? null,
      }));
    },
    async listKeywords(brandKey, configId) {
      const query = admin.from("rank_tracking_keywords").select("*").eq("brand_key", brandKey).eq("config_id", configId)
        .order("created_at", { ascending: true }).order("id", { ascending: true });
      return data<RankKeyword[]>(await query);
    },
    async keywordCounts(brandKey, configIds) {
      if (configIds.length === 0) return new Map();
      const rows = await pageAll<{ config_id: string }>((from, to) => admin.from("rank_tracking_keywords").select("config_id")
        .eq("brand_key", brandKey).in("config_id", configIds).order("id", { ascending: true }).range(from, to));
      const counts = new Map(configIds.map((id) => [id, 0]));
      for (const row of rows) counts.set(row.config_id, (counts.get(row.config_id) ?? 0) + 1);
      return counts;
    },
    async addKeywords(brandKey, configId, rows) {
      const result = await admin.rpc("add_rank_tracking_keywords", { p_brand: brandKey, p_config: configId, p_rows: rows });
      return data<string[]>(result) ?? [];
    },
    async removeKeywords(brandKey, configId, ids) {
      let removed = 0;
      for (const group of chunks(ids)) {
        const result = await admin.from("rank_tracking_keywords").delete({ count: "exact" }).eq("brand_key", brandKey).eq("config_id", configId).in("id", group);
        if (result.error) throw mapRepositoryError(result.error);
        removed += result.count ?? 0;
      }
      return removed;
    },
    async setPinned(brandKey, configId, ids, pinned) {
      if (!ids.length) return 0;
      const result = await admin.from("rank_tracking_keywords").update({ pinned_at: pinned ? new Date().toISOString() : null }, { count: "exact" })
        .eq("brand_key", brandKey).eq("config_id", configId).in("id", ids);
      if (result.error) throw mapRepositoryError(result.error);
      return result.count ?? 0;
    },
    async updateKeywordMetrics(brandKey, rows) {
      for (const row of rows) {
        const { id, ...patch } = row;
        const result = await admin.from("rank_tracking_keywords").update(patch).eq("brand_key", brandKey).eq("id", id);
        if (result.error) throw mapRepositoryError(result.error);
      }
    },
    async tryCreateRun(input) {
      return data<boolean>(await admin.rpc("try_create_rank_run", {
        p_brand: input.brand_key, p_config: input.config_id, p_run: input.id, p_trigger: input.trigger,
        p_method: input.method, p_approved_max: input.approved_max_usd,
        p_keyword_ids: input.keyword_ids, p_actor: input.created_by,
      }));
    },
    async getRun(brandKey, runId) {
      return data<RankRun | null>(await admin.from("rank_check_runs").select("*").eq("brand_key", brandKey).eq("id", runId).maybeSingle());
    },
    async getLatestRun(brandKey, configId) {
      return data<RankRun | null>(await admin.from("rank_check_runs").select("*").eq("brand_key", brandKey).eq("config_id", configId)
        .order("started_at", { ascending: false }).limit(1).maybeSingle());
    },
    async getActiveRun(brandKey, configId) {
      return data<RankRun | null>(await admin.from("rank_check_runs").select("*").eq("brand_key", brandKey).eq("config_id", configId)
        .in("status", ["pending", "running"]).maybeSingle());
    },
    async updateRun(brandKey, runId, patch) {
      return data<RankRun | null>(await admin.from("rank_check_runs").update(patch).eq("brand_key", brandKey).eq("id", runId).select("*").maybeSingle());
    },
    async setRunErrorIfEmpty(brandKey, runId, code, message) {
      const result = await admin.from("rank_check_runs").update({ error_code: code, error_message: message }).eq("brand_key", brandKey).eq("id", runId).is("error_code", null);
      if (result.error) throw mapRepositoryError(result.error);
    },
    async reserve(brandKey, runId, usd) {
      return data<boolean>(await admin.rpc("rank_check_reserve", { p_brand: brandKey, p_run: runId, p_usd: usd }));
    },
    async insertSnapshots(rows) {
      for (const group of chunks(rows)) {
        const result = await admin.from("rank_snapshots").upsert(group, { onConflict: "run_id,tracking_keyword_id,device", ignoreDuplicates: true });
        if (result.error) throw mapRepositoryError(result.error);
      }
    },
    async upsertSnapshots(rows) {
      const checkedAt = new Date().toISOString();
      for (const group of chunks(rows.map((row) => ({ ...row, checked_at: checkedAt })))) {
        const result = await admin.from("rank_snapshots").upsert(group, { onConflict: "run_id,tracking_keyword_id,device" });
        if (result.error) throw mapRepositoryError(result.error);
      }
    },
    async deleteNotFoundSnapshots(brandKey, keys) {
      let removed = 0;
      for (const key of keys) {
        const result = await admin.from("rank_snapshots").delete({ count: "exact" }).eq("brand_key", brandKey).eq("run_id", key.runId)
          .eq("tracking_keyword_id", key.trackingKeywordId).eq("device", key.device).is("position", null);
        if (result.error) throw mapRepositoryError(result.error);
        removed += result.count ?? 0;
      }
      return removed;
    },
    async snapshotsForRun(brandKey, runId) {
      return pageAll<RankSnapshot>((from, to) => admin.from("rank_snapshots").select("*").eq("brand_key", brandKey).eq("run_id", runId)
        .order("id", { ascending: true }).range(from, to));
    },
    async latestSnapshots(brandKey, configId, before) {
      return pageAll<RankSnapshot & { keyword: string }>((from, to) => admin.rpc("rank_latest_snapshots", { p_brand: brandKey, p_config: configId, p_before: before ?? null })
        .order("tracking_keyword_id", { ascending: true }).order("device", { ascending: true }).range(from, to));
    },
    async earliestSnapshots(brandKey, configId, ids) {
      return pageAll<Pick<RankSnapshot, "tracking_keyword_id" | "device" | "position" | "checked_at">>((from, to) => admin.rpc("rank_earliest_snapshots", { p_brand: brandKey, p_config: configId, p_keyword_ids: ids })
        .order("tracking_keyword_id", { ascending: true }).order("device", { ascending: true }).range(from, to));
    },
    async bestPositions(brandKey, configId) {
      // Snapshots outlive removed keywords, so this can exceed the 1,000-keyword cap.
      return pageAll<{ tracking_keyword_id: string; position: number }>((from, to) => admin.rpc("rank_best_positions", { p_brand: brandKey, p_config: configId })
        .order("tracking_keyword_id", { ascending: true }).range(from, to));
    },
    async keywordHistory(brandKey, configId, keywordId, since) {
      const result = await admin.from("rank_snapshots").select("device, checked_at, position, rank_check_runs!inner(config_id,status,brand_key)")
        .eq("brand_key", brandKey).eq("tracking_keyword_id", keywordId).eq("rank_check_runs.brand_key", brandKey)
        .eq("rank_check_runs.config_id", configId).eq("rank_check_runs.status", "completed").gte("checked_at", since).order("checked_at", { ascending: true });
      return data<RankKeywordHistoryPoint[]>(result);
    },
    async configTrend(brandKey, configId, device, since) {
      return data<RankTrendPoint[]>(await admin.rpc("rank_config_trend", { p_brand: brandKey, p_config: configId, p_device: device, p_since: since }));
    },
    async positionMatrix(brandKey, configId, device, runLimit) {
      // Up to 26 runs x 1,000 keywords.
      return pageAll<RankMatrixCell>((from, to) => admin.rpc("rank_position_matrix", { p_brand: brandKey, p_config: configId, p_device: device, p_run_limit: runLimit })
        .order("checked_at", { ascending: true }).order("run_id", { ascending: true })
        .order("tracking_keyword_id", { ascending: true, nullsFirst: false }).range(from, to));
    },
    async insertTasks(rows) {
      for (const group of chunks(rows)) {
        const result = await admin.from("rank_check_tasks").upsert(group, { onConflict: "run_id,round,tracking_keyword_id,device", ignoreDuplicates: true });
        if (result.error) throw mapRepositoryError(result.error);
      }
    },
    async tasksByState(brandKey, runId, round, states, limit, afterId) {
      let query = admin.from("rank_check_tasks").select("*").eq("brand_key", brandKey).eq("run_id", runId).eq("round", round)
        .in("state", states).order("id", { ascending: true }).limit(limit);
      if (afterId !== undefined) query = query.gt("id", afterId);
      return data<RankTask[]>(await query);
    },
    async updateTasks(rows) {
      for (const row of rows) {
        if (row.id == null) continue;
        const { id, brand_key, run_id, ...values } = row;
        const allowed = new Set(["state", "provider_task_id", "position", "url", "serp_features", "message", "updated_at"]);
        const patch = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)));
        const result = await admin.from("rank_check_tasks").update(patch).eq("brand_key", brand_key).eq("run_id", run_id).eq("id", id);
        if (result.error) throw mapRepositoryError(result.error);
      }
    },
    async expireTasks(brandKey, runId, round) {
      const result = await admin.from("rank_check_tasks").update({ state: "expired" }, { count: "exact" }).eq("brand_key", brandKey).eq("run_id", runId).eq("round", round).in("state", ["planned", "posted"]);
      if (result.error) throw mapRepositoryError(result.error);
      return result.count ?? 0;
    },
    async prune(runsBefore, tasksBefore, limit) {
      return data<{ runs: number; tasks: number }>(await admin.rpc("prune_rank_tracking", { p_runs_before: runsBefore, p_tasks_before: tasksBefore, p_limit: limit }));
    },
  };
}
