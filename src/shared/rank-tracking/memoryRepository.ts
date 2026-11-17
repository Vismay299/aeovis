// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/repositories/RankTrackingRepository.ts,
//   src/server/features/rank-tracking/repositories/runQueries.ts,
//   src/server/features/rank-tracking/repositories/snapshotQueries.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import { AppError } from "../http/appError.ts";
import type {
  RankConfig,
  RankConfigInsert,
  RankConfigPatch,
  RankKeyword,
  RankKeywordPatch,
  RankRun,
  RankRunInsert,
  RankRunPatch,
  RankSnapshot,
  RankTask,
  RankSummary,
  RankTrendPoint,
  RankMatrixCell,
  RankKeywordHistoryPoint,
  RankTrackingRepository,
} from "./repository.ts";

export type MemoryRankTrackingSeed = {
  now?: () => Date;
  configs?: RankConfig[];
  keywords?: RankKeyword[];
  runs?: RankRun[];
  snapshots?: RankSnapshot[];
  tasks?: RankTask[];
};
export type MemoryRankTrackingRepository = RankTrackingRepository & {
  configs: Map<string, RankConfig>;
  keywords: Map<string, RankKeyword>;
  runs: Map<string, RankRun>;
  snapshots: RankSnapshot[];
  tasks: RankTask[];
};
const clone = <T>(v: T): T => structuredClone(v);
const marketKey = (
  r: Pick<
    RankConfig,
    "brand_key" | "domain" | "location_code" | "language_code" | "location_name"
  >,
) =>
  [
    r.brand_key,
    r.domain,
    r.location_code,
    r.language_code,
    r.location_name ?? "<national>",
  ].join("\0");
const snapshotKey = (
  r: Pick<RankSnapshot, "run_id" | "tracking_keyword_id" | "device">,
) => [r.run_id, r.tracking_keyword_id, r.device].join("\0");
const err = (code: string, message: string, status = 503) =>
  new AppError(status, code, message);

export function createMemoryRankTrackingRepository(
  seed: MemoryRankTrackingSeed = {},
): MemoryRankTrackingRepository {
  const now = seed.now ?? (() => new Date());
  let seq = 0,
    taskSeq = Math.max(0, ...(seed.tasks ?? []).map((x) => x.id ?? 0)),
    snapSeq = Math.max(0, ...(seed.snapshots ?? []).map((x) => x.id ?? 0));
  const stamp = () => new Date(now().getTime() + seq++).toISOString();
  const configs = new Map((seed.configs ?? []).map((x) => [x.id, clone(x)]));
  const keywords = new Map((seed.keywords ?? []).map((x) => [x.id, clone(x)]));
  const runs = new Map((seed.runs ?? []).map((x) => [x.id, clone(x)]));
  const snapshots = (seed.snapshots ?? []).map(clone),
    tasks = (seed.tasks ?? []).map(clone);
  const config = (b: string, id: string) => {
    const x = configs.get(id);
    return x?.brand_key === b ? x : null;
  };
  const run = (b: string, id: string) => {
    const x = runs.get(id);
    return x?.brand_key === b ? x : null;
  };
  const ownedKeywords = (b: string, c: string) =>
    [...keywords.values()].filter(
      (x) => x.brand_key === b && x.config_id === c,
    );
  const completed = (b: string, c: string, id: string) => {
    const x = runs.get(id);
    return x?.brand_key === b && x.config_id === c && x.status === "completed"
      ? x
      : null;
  };
  const repo: MemoryRankTrackingRepository = {
    configs,
    keywords,
    runs,
    snapshots,
    tasks,
    async listSummaries(b): Promise<RankSummary[]> {
      return [...configs.values()]
        .filter((x) => x.brand_key === b && x.is_active)
        .sort((a, z) => a.created_at.localeCompare(z.created_at))
        .map((c) => {
          const latest = [...runs.values()]
            .filter((x) => x.brand_key === b && x.config_id === c.id)
            .sort((a, z) => z.started_at.localeCompare(a.started_at))[0];
          return {
            id: c.id,
            domain: c.domain,
            location_code: c.location_code,
            language_code: c.language_code,
            location_name: c.location_name,
            devices: c.devices,
            serp_depth: c.serp_depth,
            schedule_interval: c.schedule_interval,
            next_check_at: c.next_check_at,
            last_checked_at: c.last_checked_at,
            last_skip_reason: c.last_skip_reason,
            last_skip_at: c.last_skip_at,
            approved_max_usd: c.approved_max_usd,
            created_at: c.created_at,
            keyword_count: ownedKeywords(b, c.id).length,
            last_run_status: latest?.status ?? null,
            last_run_completed_at: latest?.completed_at ?? null,
          };
        });
    },
    async getConfig(b, id) {
      const x = config(b, id);
      return x ? clone(x) : null;
    },
    async findConfigByMarket(b, domain, location, language, name) {
      const x = [...configs.values()].find(
        (v) =>
          marketKey(v) ===
          marketKey({
            brand_key: b,
            domain,
            location_code: location,
            language_code: language,
            location_name: name,
          }),
      );
      return x ? clone(x) : null;
    },
    async countActiveConfigs(b) {
      return [...configs.values()].filter(
        (x) => x.brand_key === b && x.is_active,
      ).length;
    },
    async insertConfig(input: RankConfigInsert) {
      const x = {
        ...input,
        id: input.id ?? randomUUID(),
        created_at: input.created_at ?? stamp(),
        updated_at: input.updated_at ?? stamp(),
      } as RankConfig;
      if ([...configs.values()].some((v) => marketKey(v) === marketKey(x)))
        throw err(
          "tracker_exists",
          "This domain and market are already tracked.",
          409,
        );
      configs.set(x.id, clone(x));
      return clone(x);
    },
    async updateConfig(b, id, patch: RankConfigPatch) {
      const x = config(b, id);
      if (!x) return null;
      const next = {
        ...x,
        ...patch,
        id: x.id,
        brand_key: x.brand_key,
        created_at: x.created_at,
        updated_at: stamp(),
      };
      if (
        [...configs.values()].some(
          (v) => v.id !== id && marketKey(v) === marketKey(next),
        )
      )
        throw err(
          "tracker_exists",
          "This domain and market are already tracked.",
          409,
        );
      configs.set(id, next);
      return clone(next);
    },
    async listDueConfigs(at, limit = 500) {
      return [...configs.values()]
        .filter(
          (x) =>
            x.is_active &&
            x.schedule_interval !== "manual" &&
            x.next_check_at !== null &&
            x.next_check_at <= at,
        )
        .sort(
          (a, z) =>
            (a.next_check_at ?? "").localeCompare(z.next_check_at ?? "") ||
            a.id.localeCompare(z.id),
        )
        .slice(0, limit)
        .map(clone);
    },
    async claimConfig(b, id, observed, next, skip) {
      const x = config(b, id);
      if (
        !x ||
        !x.is_active ||
        x.schedule_interval === "manual" ||
        x.next_check_at !== observed
      )
        return false;
      x.next_check_at = next;
      if (skip !== undefined) {
        x.last_skip_reason = skip.reason;
        x.last_skip_at = skip.reason === null ? null : stamp();
      }
      x.updated_at = stamp();
      return true;
    },
    async listKeywords(b, c) {
      return ownedKeywords(b, c)
        .sort(
          (a, z) =>
            a.created_at.localeCompare(z.created_at) ||
            a.id.localeCompare(z.id),
        )
        .map(clone);
    },
    async keywordCounts(b, ids) {
      const out = new Map(ids.map((x) => [x, 0]));
      for (const k of keywords.values())
        if (k.brand_key === b && out.has(k.config_id))
          out.set(k.config_id, (out.get(k.config_id) ?? 0) + 1);
      return out;
    },
    async addKeywords(b, c, rows) {
      if (!config(b, c))
        throw err(
          "tracker_not_found",
          "This tracked domain does not exist.",
          404,
        );
      const currentKeywords = ownedKeywords(b, c);
      const n = currentKeywords.length;
      if (n >= 1000)
        throw err(
          "keyword_limit",
          "A domain can track up to 1,000 keywords. Remove some first.",
          409,
        );
      const candidates = rows.slice(0, 1000 - n);
      const existing = new Set(currentKeywords.map((keyword) => keyword.keyword));
      const seen = new Set(existing);
      const validated = candidates.map((row) => {
        if (
          typeof row.keyword !== "string" ||
          !row.keyword.trim() ||
          row.keyword.length > 200
        )
          throw err(
            "rank_tracking_unavailable",
            "Rank tracking could not be saved. Please retry.",
          );
        const matchCase = row.match_case ?? false;
        if (!matchCase && row.keyword !== row.keyword.toLowerCase())
          throw err(
            "rank_tracking_unavailable",
            "Rank tracking could not be saved. Please retry.",
          );
        return { row, matchCase };
      });
      const staged: RankKeyword[] = [];
      for (const { row, matchCase } of validated) {
        if (seen.has(row.keyword)) continue;
        seen.add(row.keyword);
        staged.push({
          id: row.id ?? randomUUID(),
          brand_key: b,
          config_id: c,
          keyword: row.keyword,
          match_case: matchCase,
          search_volume: row.search_volume ?? null,
          keyword_difficulty: row.keyword_difficulty ?? null,
          cpc: row.cpc ?? null,
          metrics_fetched_at: row.metrics_fetched_at ?? null,
          metrics_source: row.metrics_source ?? null,
          pinned_at: row.pinned_at ?? null,
          created_at: row.created_at ?? stamp(),
        });
      }
      for (const row of staged) keywords.set(row.id, row);
      return staged.map((row) => row.id);
    },
    async removeKeywords(b, c, ids) {
      let n = 0;
      for (const id of new Set(ids)) {
        const x = keywords.get(id);
        if (x?.brand_key === b && x.config_id === c) {
          keywords.delete(id);
          n++;
        }
      }
      return n;
    },
    async setPinned(b, c, ids, pinned) {
      let n = 0;
      const wanted = new Set(ids),
        at = pinned ? stamp() : null;
      for (const x of keywords.values())
        if (x.brand_key === b && x.config_id === c && wanted.has(x.id)) {
          x.pinned_at = at;
          n++;
        }
      return n;
    },
    async updateKeywordMetrics(
      b,
      rows: Array<RankKeywordPatch & Pick<RankKeyword, "id">>,
    ) {
      for (const r of rows) {
        const x = keywords.get(r.id);
        if (x?.brand_key === b)
          Object.assign(x, r, {
            id: x.id,
            brand_key: x.brand_key,
            config_id: x.config_id,
            created_at: x.created_at,
          });
      }
    },
    async tryCreateRun(input: RankRunInsert) {
      const c = config(input.brand_key, input.config_id);
      if (!c || !c.is_active)
        throw err(
          "tracker_not_found",
          "This tracked domain does not exist.",
          404,
        );
      if (
        [...runs.values()].some(
          (x) =>
            x.brand_key === input.brand_key &&
            x.config_id === input.config_id &&
            ["pending", "running"].includes(x.status),
        )
      )
        return false;
      if (runs.has(input.id)) return false;
      const ids = input.keyword_ids ?? [];
      runs.set(input.id, {
        id: input.id,
        brand_key: input.brand_key,
        config_id: input.config_id,
        job_id: input.job_id ?? null,
        trigger: input.trigger,
        method: input.method,
        status: "pending",
        phase: null,
        domain: c.domain,
        location_code: c.location_code,
        language_code: c.language_code,
        location_name: c.location_name,
        devices: c.devices,
        serp_depth: c.serp_depth,
        keyword_ids: [...ids],
        is_subset_run: ids.length > 0,
        keywords_total: ids.length,
        keywords_checked: 0,
        approved_max_usd: input.approved_max_usd,
        reserved_usd: 0,
        error_code: null,
        error_message: null,
        created_by: input.created_by,
        started_at: stamp(),
        completed_at: null,
      });
      return true;
    },
    async getRun(b, id) {
      const x = run(b, id);
      return x ? clone(x) : null;
    },
    async getLatestRun(b, c) {
      const x = [...runs.values()]
        .filter((r) => r.brand_key === b && r.config_id === c)
        .sort((a, z) => z.started_at.localeCompare(a.started_at))[0];
      return x ? clone(x) : null;
    },
    async getActiveRun(b, c) {
      const x = [...runs.values()].find(
        (r) =>
          r.brand_key === b &&
          r.config_id === c &&
          ["pending", "running"].includes(r.status),
      );
      return x ? clone(x) : null;
    },
    async updateRun(b, id, patch: RankRunPatch) {
      const x = run(b, id);
      if (!x) return null;
      Object.assign(x, patch, {
        id: x.id,
        brand_key: x.brand_key,
        config_id: x.config_id,
        started_at: x.started_at,
      });
      return clone(x);
    },
    async setRunErrorIfEmpty(b, id, code, message) {
      const x = run(b, id);
      if (x && x.error_code === null) {
        x.error_code = code;
        x.error_message = message;
      }
    },
    async reserve(b, id, usd) {
      const x = run(b, id);
      if (
        !x ||
        usd <= 0 ||
        !["pending", "running"].includes(x.status) ||
        x.reserved_usd + usd > x.approved_max_usd
      )
        return false;
      x.reserved_usd = Math.round((x.reserved_usd + usd) * 1e6) / 1e6;
      return true;
    },
    async insertSnapshots(rows) {
      for (const r of rows)
        if (!snapshots.some((x) => snapshotKey(x) === snapshotKey(r)))
          snapshots.push({
            ...clone(r),
            id: r.id ?? ++snapSeq,
            checked_at: r.checked_at ?? stamp(),
          });
    },
    async upsertSnapshots(rows) {
      for (const r of rows) {
        const x = snapshots.find(
          (v) =>
            v.brand_key === r.brand_key && snapshotKey(v) === snapshotKey(r),
        );
        if (x) Object.assign(x, r, { id: x.id, checked_at: stamp() });
        else
          snapshots.push({
            ...clone(r),
            id: r.id ?? ++snapSeq,
            checked_at: stamp(),
          });
      }
    },
    async deleteNotFoundSnapshots(b, keys) {
      const selected = new Set(
        keys.map((x) => [x.runId, x.trackingKeywordId, x.device].join("\0")),
      );
      let n = 0;
      for (let i = snapshots.length - 1; i >= 0; i--) {
        const x = snapshots[i];
        if (
          x.brand_key === b &&
          x.position === null &&
          selected.has([x.run_id, x.tracking_keyword_id, x.device].join("\0"))
        ) {
          snapshots.splice(i, 1);
          n++;
        }
      }
      return n;
    },
    async snapshotsForRun(b, id) {
      return snapshots
        .filter((x) => x.brand_key === b && x.run_id === id)
        .sort((a, z) => (a.id ?? 0) - (z.id ?? 0))
        .map(clone);
    },
    async latestSnapshots(b, c, before) {
      const xs = snapshots
        .filter(
          (x) =>
            x.brand_key === b &&
            completed(b, c, x.run_id) &&
            (before === undefined || (x.checked_at ?? "") <= before),
        )
        .sort(
          (a, z) =>
            (z.checked_at ?? "").localeCompare(a.checked_at ?? "") ||
            (z.id ?? 0) - (a.id ?? 0),
        );
      const out = new Map<string, RankSnapshot & { keyword: string }>();
      for (const x of xs) {
        const key = x.tracking_keyword_id + "\0" + x.device;
        if (!out.has(key)) out.set(key, { ...clone(x), keyword: x.keyword });
      }
      return [...out.values()];
    },
    async earliestSnapshots(b, c, ids) {
      const wanted = new Set(ids),
        out = new Map<string, RankSnapshot>();
      for (const x of snapshots
        .filter(
          (s) =>
            s.brand_key === b &&
            wanted.has(s.tracking_keyword_id) &&
            completed(b, c, s.run_id),
        )
        .sort(
          (a, z) =>
            (a.checked_at ?? "").localeCompare(z.checked_at ?? "") ||
            (a.id ?? 0) - (z.id ?? 0),
        )) {
        const key = x.tracking_keyword_id + "\0" + x.device;
        if (!out.has(key)) out.set(key, x);
      }
      return [...out.values()].map(
        ({ tracking_keyword_id, device, position, checked_at }) => ({
          tracking_keyword_id,
          device,
          position,
          checked_at,
        }),
      );
    },
    async bestPositions(b, c) {
      const best = new Map<string, number>();
      for (const x of snapshots)
        if (
          x.brand_key === b &&
          x.position !== null &&
          completed(b, c, x.run_id)
        )
          best.set(
            x.tracking_keyword_id,
            Math.min(best.get(x.tracking_keyword_id) ?? Infinity, x.position),
          );
      return [...best].map(([tracking_keyword_id, position]) => ({
        tracking_keyword_id,
        position,
      }));
    },
    async keywordHistory(b, c, id, since): Promise<RankKeywordHistoryPoint[]> {
      return snapshots
        .filter(
          (x) =>
            x.brand_key === b &&
            x.tracking_keyword_id === id &&
            (x.checked_at ?? "") >= since &&
            completed(b, c, x.run_id),
        )
        .sort((a, z) => (a.checked_at ?? "").localeCompare(z.checked_at ?? ""))
        .map((x) => ({
          device: x.device,
          checked_at: x.checked_at!,
          position: x.position,
        }));
    },
    async configTrend(b, c, device, since): Promise<RankTrendPoint[]> {
      return [...runs.values()]
        .filter(
          (r) =>
            r.brand_key === b &&
            r.config_id === c &&
            r.status === "completed" &&
            !r.is_subset_run &&
            r.started_at >= since,
        )
        .map((r) => {
          const xs = snapshots.filter(
            (x) =>
              x.brand_key === b && x.run_id === r.id && x.device === device,
          );
          return {
            run_id: r.id,
            checked_at: r.started_at,
            keywords_total: r.keywords_total,
            total: xs.length,
            top3: xs.filter((x) => x.position !== null && x.position <= 3)
              .length,
            top4to10: xs.filter(
              (x) => x.position !== null && x.position >= 4 && x.position <= 10,
            ).length,
            top11to20: xs.filter(
              (x) =>
                x.position !== null && x.position >= 11 && x.position <= 20,
            ).length,
            ai_overview: xs.filter((x) =>
              x.serp_features.includes("ai_overview"),
            ).length,
          };
        })
        .sort((a, z) => a.checked_at.localeCompare(z.checked_at));
    },
    async positionMatrix(b, c, device, limit): Promise<RankMatrixCell[]> {
      const rs = [...runs.values()]
        .filter(
          (r) =>
            r.brand_key === b &&
            r.config_id === c &&
            r.status === "completed" &&
            !r.is_subset_run,
        )
        .sort((a, z) => z.started_at.localeCompare(a.started_at))
        .slice(0, Math.max(1, Math.min(limit, 26)))
        .sort((a, z) => a.started_at.localeCompare(z.started_at));
      return rs.flatMap<RankMatrixCell>((selectedRun) => {
        const runSnapshots = snapshots.filter(
          (snapshot) =>
            snapshot.brand_key === b && snapshot.run_id === selectedRun.id,
        );
        const keywordIds = [...new Set(
          runSnapshots.map((snapshot) => snapshot.tracking_keyword_id),
        )];
        if (keywordIds.length === 0) {
          return [{
            run_id: selectedRun.id,
            checked_at: selectedRun.started_at,
            tracking_keyword_id: null,
            position: null,
          }];
        }
        return keywordIds.map((keywordId) => ({
          run_id: selectedRun.id,
          checked_at: selectedRun.started_at,
          tracking_keyword_id: keywordId,
          position: runSnapshots.find(
            (snapshot) =>
              snapshot.tracking_keyword_id === keywordId &&
              snapshot.device === device,
          )?.position ?? null,
        }));
      });
    },
    async insertTasks(rows) {
      for (const r of rows)
        if (
          !tasks.some(
            (x) =>
              x.run_id === r.run_id &&
              x.round === r.round &&
              x.tracking_keyword_id === r.tracking_keyword_id &&
              x.device === r.device,
          )
        )
          tasks.push({
            ...clone(r),
            id: r.id ?? ++taskSeq,
            created_at: r.created_at ?? stamp(),
            updated_at: r.updated_at ?? stamp(),
          });
    },
    async tasksByState(b, id, round, states, limit, afterId) {
      const allowed = new Set(states);
      return tasks
        .filter(
          (x) =>
            x.brand_key === b &&
            x.run_id === id &&
            x.round === round &&
            allowed.has(x.state) &&
            (afterId === undefined || (x.id ?? 0) > afterId),
        )
        .sort((a, z) => (a.id ?? 0) - (z.id ?? 0))
        .slice(0, limit)
        .map(clone);
    },
    async updateTasks(rows) {
      for (const input of rows) {
        const x = tasks.find(
          (r) =>
            r.id === input.id &&
            r.brand_key === input.brand_key &&
            r.run_id === input.run_id,
        );
        if (x) {
          const allowed = new Set([
            "state",
            "provider_task_id",
            "position",
            "url",
            "serp_features",
            "message",
            "updated_at",
          ]);
          const patch = Object.fromEntries(
            Object.entries(input).filter(([key]) => allowed.has(key)),
          );
          Object.assign(x, patch, {
            id: x.id,
            brand_key: x.brand_key,
            run_id: x.run_id,
          });
          x.updated_at = stamp();
        }
      }
    },
    async expireTasks(b, id, round) {
      let n = 0;
      for (const x of tasks)
        if (
          x.brand_key === b &&
          x.run_id === id &&
          x.round === round &&
          ["planned", "posted"].includes(x.state)
        ) {
          x.state = "expired";
          x.updated_at = stamp();
          n++;
        }
      return n;
    },
    async prune(runsBefore, tasksBefore, limit) {
      const doomed = [...runs.values()]
        .filter(
          (x) =>
            x.started_at < runsBefore &&
            ["completed", "failed"].includes(x.status),
        )
        .sort((a, z) => a.started_at.localeCompare(z.started_at))
        .slice(0, Math.max(1, Math.min(limit, 5000)));
      const ids = new Set(doomed.map((x) => x.id));
      for (const x of doomed) runs.delete(x.id);
      for (let i = snapshots.length - 1; i >= 0; i--)
        if (ids.has(snapshots[i].run_id)) snapshots.splice(i, 1);
      for (let i = tasks.length - 1; i >= 0; i--)
        if (ids.has(tasks[i].run_id)) tasks.splice(i, 1);
      const old = tasks
        .filter((x) => (x.created_at ?? "") < tasksBefore)
        .sort((a, z) => (a.created_at ?? "").localeCompare(z.created_at ?? ""))
        .slice(0, Math.max(1, Math.min(limit * 10, 50000)));
      const oldIds = new Set(old.map((x) => x.id));
      for (let i = tasks.length - 1; i >= 0; i--)
        if (oldIds.has(tasks[i].id)) tasks.splice(i, 1);
      return { runs: doomed.length, tasks: old.length };
    },
  };
  return repo;
}
