// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/RankTrackingService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { requireApprovedPrice, recordApproval, quote } from "../pricing/pricedActions.ts";
import { createRankTrackingRepository } from "./repository.ts";
import { normalizeTrackedDomain, resolveTrackerMarket, assertTrackedLocation } from "./market.ts";
import { resolveKeywordDataLanguage } from "../../shared/keyword-locations.ts";
import { computeNextRunAt } from "../../shared/schedule.ts";

export type Workspace = { brandKey: string; userId: string | null; admin: any };

export type CreateConfigBody = {
  domain: string;
  locationCode?: number;
  languageCode?: string;
  locationName?: string | null;
  devices?: string;
  serpDepth?: number;
  scheduleInterval?: string;
  scheduleTime?: any;
};

export type UpdateConfigBody = {
  domain?: string;
  locationCode?: number;
  languageCode?: string;
  locationName?: string | null;
  devices?: string;
  serpDepth?: number;
  scheduleInterval?: string;
  scheduleTime?: any;
  isActive?: boolean;
  maxUsd?: number;
};

export type AddKeywordsBody = {
  keywords: string[];
  matchCase?: boolean;
  source?: string;
  maxUsd?: number;
};

export type ServiceDeps = {
  repo?: ReturnType<typeof createRankTrackingRepository>;
  fetchSerpLocationsForCountry?: (iso: string) => Promise<any[]>;
  quote?: typeof quote;
  requireApprovedPrice?: typeof requireApprovedPrice;
  recordApproval?: typeof recordApproval;
};

function getRepo(admin: any, deps?: ServiceDeps) {
  return deps?.repo ?? createRankTrackingRepository(admin);
}

export async function createConfig(ws: Workspace, body: CreateConfigBody, deps?: ServiceDeps): Promise<any> {
  const admin = ws.admin;
  const repo = getRepo(admin, deps);
  const domain = normalizeTrackedDomain(body.domain);
  const market = resolveTrackerMarket(
    { locationCode: body.locationCode, languageCode: body.languageCode },
    { website_host: (ws as any).website_host ?? "" } as any,
  );
  const locationName = body.locationName ?? null;
  await assertTrackedLocation(market.locationCode, locationName, deps?.fetchSerpLocationsForCountry ? { fetchSerpLocationsForCountry: deps.fetchSerpLocationsForCountry } : undefined);

  const interval = body.scheduleInterval ?? "weekly";
  if (interval === "manual" && body.scheduleTime) {
    throw new AppError(400, "schedule_time_without_schedule", "A schedule time needs a daily, weekly, or monthly schedule.");
  }
  if (interval === "weekly" && body.scheduleTime && !body.scheduleTime.weekday) {
    throw new AppError(400, "schedule_weekday_required", "A weekly schedule time needs a weekday.");
  }
  const nextCheckAt = interval === "manual" ? null : computeNextRunAt(interval as any, null, body.scheduleTime);

  // duplicate check
  const existing = await repo.findConfigByMarket(ws.brandKey, domain, market.locationCode, market.languageCode, locationName);
  if (existing && existing.is_active) {
    throw new AppError(409, "tracker_exists", locationName ? "This domain, city and language are already tracked." : "This domain, country and language are already tracked.");
  }

  const count = await repo.countActiveConfigs(ws.brandKey);
  if (count >= 500) {
    throw new AppError(409, "tracker_limit", "A workspace can track up to 500 domains. Archive some first.");
  }

  let config: any;
  if (existing && !existing.is_active) {
    // reactivate: keep approved_max only if schedule and devices/depth unchanged, else NULL
    const sameSchedule = (body.scheduleInterval ?? existing.schedule_interval) === existing.schedule_interval;
    const sameDevices = (body.devices ?? existing.devices) === existing.devices;
    const sameDepth = (body.serpDepth ?? existing.serp_depth) === existing.serp_depth;
    const keepApproval = sameSchedule && sameDevices && sameDepth;
    config = await repo.updateConfig(ws.brandKey, existing.id, {
      domain,
      location_code: market.locationCode,
      language_code: market.languageCode,
      location_name: locationName,
      devices: body.devices ?? existing.devices,
      serp_depth: body.serpDepth ?? existing.serp_depth,
      schedule_interval: interval,
      next_check_at: nextCheckAt,
      is_active: true,
      last_skip_reason: null,
      approved_max_usd: keepApproval ? existing.approved_max_usd : null,
    } as any);
  } else {
    config = await repo.insertConfig({
      brand_key: ws.brandKey,
      domain,
      location_code: market.locationCode,
      language_code: market.languageCode,
      location_name: locationName,
      devices: body.devices ?? "mobile",
      serp_depth: body.serpDepth ?? 40,
      schedule_interval: interval,
      is_active: true,
      next_check_at: nextCheckAt,
      created_by: ws.userId,
    } as any);
  }
  return { tracker: config };
}

export async function updateConfig(ws: Workspace, configId: string, body: UpdateConfigBody, deps?: ServiceDeps): Promise<any> {
  const admin = ws.admin;
  const repo = getRepo(admin, deps);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");

  const patch: any = {};
  if (body.domain != null) patch.domain = normalizeTrackedDomain(body.domain);
  if (body.locationCode != null || body.languageCode != null) {
    const market = resolveTrackerMarket(
      { locationCode: body.locationCode ?? config.location_code, languageCode: body.languageCode ?? config.language_code },
      { website_host: "" } as any,
    );
    patch.location_code = market.locationCode;
    patch.language_code = market.languageCode;
  }
  if (body.locationName !== undefined) {
    const ln = body.locationName;
    await assertTrackedLocation(body.locationCode ?? config.location_code, ln, deps?.fetchSerpLocationsForCountry ? { fetchSerpLocationsForCountry: deps.fetchSerpLocationsForCountry } : undefined);
    patch.location_name = ln;
  }
  if (body.devices != null) patch.devices = body.devices;
  if (body.serpDepth != null) patch.serp_depth = body.serpDepth;
  if (body.scheduleInterval != null) patch.schedule_interval = body.scheduleInterval;
  if (body.isActive != null) patch.is_active = body.isActive;

  // duplicate check on market change
  if (patch.domain || patch.location_code || patch.language_code || patch.location_name !== undefined) {
    const dup = await repo.findConfigByMarket(
      ws.brandKey,
      patch.domain ?? config.domain,
      patch.location_code ?? config.location_code,
      patch.language_code ?? config.language_code,
      patch.location_name !== undefined ? patch.location_name : config.location_name,
    );
    if (dup && dup.id !== configId && dup.is_active) {
      throw new AppError(409, "tracker_exists", (patch.location_name ?? config.location_name) ? "This domain, city and language are already tracked." : "This domain, country and language are already tracked.");
    }
  }

  if (body.isActive === false) {
    // archive
    const updated = await repo.updateConfig(ws.brandKey, configId, { ...patch, is_active: false } as any);
    return { tracker: updated };
  }

  // approval handling for scheduled
  const newInterval = body.scheduleInterval ?? config.schedule_interval;
  const newDevices = body.devices ?? config.devices;
  const newDepth = body.serpDepth ?? config.serp_depth;
  const keywords = await repo.listKeywords(ws.brandKey, configId);
  const isScheduled = newInterval !== "manual";
  if (isScheduled && keywords.length > 0) {
    const quoteFn = deps?.quote ?? quote;
    const requireFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
    const recordFn = deps?.recordApproval ?? recordApproval;
    const q = await quoteFn("rank_tracking.config.save", { brandKey: ws.brandKey, admin: ws.admin } as any, {
      configId,
      devices: newDevices,
      serpDepth: newDepth,
      scheduleInterval: newInterval,
    } as any);
    const approvedMax = config.approved_max_usd;
    if (q.totalUsd > (approvedMax ?? 0)) {
      if (body.maxUsd == null) throw new AppError(400, "approval_required", "Approval required.", { details: { quote: q } });
      const approved = await requireFn("rank_tracking.config.save", { brandKey: ws.brandKey, admin: ws.admin } as any, { configId, devices: newDevices, serpDepth: newDepth, scheduleInterval: newInterval } as any, body.maxUsd);
      await recordFn(ws.admin, { brandKey: ws.brandKey, action: "rank_tracking.config.save", approvedMaxUsd: body.maxUsd, quote: approved.quote, source: "schedule", subject: { kind: "rank_tracking_config", id: configId } });
      patch.approved_max_usd = body.maxUsd;
    }
  }

  if (body.scheduleTime !== undefined) {
    const interval = newInterval;
    if (interval === "manual") {
      patch.next_check_at = null;
    } else {
      if (interval === "weekly" && body.scheduleTime && !body.scheduleTime.weekday) {
        throw new AppError(400, "schedule_weekday_required", "A weekly schedule time needs a weekday.");
      }
      patch.next_check_at = computeNextRunAt(interval as any, config.next_check_at, body.scheduleTime);
    }
  }

  const updated = await repo.updateConfig(ws.brandKey, configId, patch);
  return { tracker: updated };
}

export async function addKeywords(ws: Workspace, configId: string, body: AddKeywordsBody, deps?: ServiceDeps): Promise<any> {
  const admin = ws.admin;
  const repo = getRepo(admin, deps);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");

  const normalized = body.keywords.map((k) => (body.matchCase ? k.trim() : k.trim().toLowerCase()));
  for (const kw of normalized) {
    if (!kw || kw.length < 1 || kw.length > 200) {
      throw new AppError(400, "invalid_request", "Check request fields and try again.");
    }
  }
  // dedupe against request
  const unique = Array.from(new Set(normalized));
  // dedupe against existing
  const existing = await repo.listKeywords(ws.brandKey, configId);
  const existingSet = new Set(existing.map((k: any) => k.keyword));
  const toAdd = unique.filter((k) => !existingSet.has(k));

  const skipped = body.keywords.length - toAdd.length;

  // metrics prefill for national (location_name null)
  const rows: any[] = [];
  let metricsFromCache = 0;
  if (config.location_name == null) {
    // one select on keyword_metrics with language resolution
    const dataLang = resolveKeywordDataLanguage(config.location_code, config.language_code);
    const { data } = await admin
      .from("keyword_metrics")
      .select("keyword, search_volume, keyword_difficulty, cpc, fetched_at")
      .eq("location_code", config.location_code)
      .eq("language_code", dataLang)
      .in("keyword", toAdd.map((k) => k.toLowerCase()));
    const fresh = ((data as any[]) ?? []).filter((r: any) => new Date(r.fetched_at).getTime() > Date.now() - 7 * 86400000);
    const byKw = new Map(fresh.map((r: any) => [r.keyword, r]));
    for (const kw of toAdd) {
      const m = byKw.get(kw.toLowerCase());
      if (m) {
        rows.push({
          keyword: kw,
          match_case: body.matchCase ?? false,
          search_volume: m.search_volume,
          keyword_difficulty: m.keyword_difficulty,
          cpc: m.cpc,
          metrics_fetched_at: m.fetched_at,
          metrics_source: "cache",
        });
        metricsFromCache++;
      } else {
        rows.push({ keyword: kw, match_case: body.matchCase ?? false });
      }
    }
  } else {
    for (const kw of toAdd) rows.push({ keyword: kw, match_case: body.matchCase ?? false });
  }

  // scheduled approval handling
  let approval: any = null;
  if (config.schedule_interval !== "manual" && toAdd.length > 0) {
    const quoteFn = deps?.quote ?? quote;
    const requireFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
    const recordFn = deps?.recordApproval ?? recordApproval;
    const q = await quoteFn("rank_tracking.config.save", { brandKey: ws.brandKey, admin } as any, {
      configId,
      addKeywords: toAdd,
      devices: config.devices,
      serpDepth: config.serp_depth,
      scheduleInterval: config.schedule_interval,
    } as any);
    const approvedMax = config.approved_max_usd;
    if (q.totalUsd > (approvedMax ?? 0)) {
      if (body.maxUsd == null) throw new AppError(400, "approval_required", "Approval required.", { details: { quote: q } });
      const approved = await requireFn("rank_tracking.config.save", { brandKey: ws.brandKey, admin } as any, {
        configId,
        addKeywords: toAdd,
        devices: config.devices,
        serpDepth: config.serp_depth,
        scheduleInterval: config.schedule_interval,
      } as any, body.maxUsd);
      await recordFn(ws.admin, { brandKey: ws.brandKey, action: "rank_tracking.config.save", approvedMaxUsd: body.maxUsd, quote: approved.quote, source: "dialog", subject: { kind: "rank_tracking_config", id: configId } });
      await repo.updateConfig(ws.brandKey, configId, { approved_max_usd: body.maxUsd } as any);
      approval = { approvedMaxUsd: body.maxUsd, quote: q };
    }
  }

  const addedIds = await repo.addKeywords(ws.brandKey, configId, rows);
  return { added: addedIds.length, addedIds, skipped, metricsFromCache, approval };
}

export async function removeKeywords(ws: Workspace, configId: string, keywordIds: string[]): Promise<any> {
  const repo = createRankTrackingRepository(ws.admin);
  const removed = await repo.removeKeywords(ws.brandKey, configId, keywordIds);
  return { removed, removedIds: keywordIds };
}

export async function setKeywordsPinned(ws: Workspace, configId: string, keywordIds: string[], pinned: boolean): Promise<any> {
  const repo = createRankTrackingRepository(ws.admin);
  const updated = await repo.setPinned(ws.brandKey, configId, keywordIds, pinned);
  return { updated, updatedIds: keywordIds };
}

export async function listTrackers(ws: Workspace): Promise<any[]> {
  const repo = createRankTrackingRepository(ws.admin);
  return repo.listSummaries(ws.brandKey);
}

export async function getTracker(ws: Workspace, configId: string): Promise<any> {
  const repo = createRankTrackingRepository(ws.admin);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  return { tracker: config };
}
