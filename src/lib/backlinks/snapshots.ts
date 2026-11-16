import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AppError } from "../http/appError.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import { quote as quotePricedAction } from "../pricing/pricedActions.ts";
import { normalizeBacklinksTarget } from "../providers/dataforseo/backlinksTarget.ts";
import type { BacklinksSummaryItem } from "../providers/dataforseo/backlinks.ts";
import type { BacklinksOverviewResult } from "./backlinksOverviewSchema.ts";
import type { ScheduleInterval } from "../../shared/schedule.ts";

export const SNAPSHOT_SKIP_REASONS = [
  "snapshots_disabled",
  "workspace_inactive",
  "price_changed",
  "feature_disabled",
  "daily_cap",
  "workspace_cap",
  "start_failed",
] as const;
export type SnapshotSkipReason = (typeof SNAPSHOT_SKIP_REASONS)[number];

const SNAPSHOT_SKIP_MESSAGES: Record<SnapshotSkipReason, string> = {
  snapshots_disabled: "History tracking is turned off for this workspace.",
  workspace_inactive: "This workspace is inactive.",
  price_changed: "The price rose above what you approved. Approve the new price to continue.",
  feature_disabled: "Backlink history is not enabled for this workspace.",
  daily_cap: "Today's spend limit was reached.",
  workspace_cap: "This month's spend limit was reached.",
  start_failed: "The snapshot could not be taken. It will try again next time.",
};

export function snapshotSkipMessage(reason: string): string | null {
  return SNAPSHOT_SKIP_MESSAGES[reason as SnapshotSkipReason] ?? null;
}

export const snapshotScopeSchema = z.enum(["domain", "subdomains"]);
export const snapshotIntervalSchema = z.enum(["weekly", "monthly"]);

export type SnapshotTarget = {
  id: string;
  brand_key: string;
  target: string;
  scope: "domain" | "subdomains";
  label: string | null;
  schedule_interval: "weekly" | "monthly";
  enabled: boolean;
  next_run_at: string;
  approved_max_usd: number | string;
  approval_id: string | null;
  last_run_at: string | null;
  last_skip_reason: string | null;
  last_skip_at: string | null;
};

export type DueSnapshotTarget = {
  key: string;
  observedNextRunAt: string;
  interval: ScheduleInterval;
  brandKey: string;
  target: string;
  scope: "domain" | "subdomains";
  approvedMaxUsd: number;
  workspaceActive: boolean;
};

function unavailable(): AppError {
  return new AppError(
    503,
    "snapshots_unavailable",
    "Backlink history is unavailable. Please retry.",
  );
}

function mapSnapshotError(error: unknown): never {
  const e = error as { code?: string; message?: string; details?: string };
  const message = `${e?.message ?? ""} ${e?.details ?? ""}`;
  if (message.includes("backlink_snapshots_cap:targets")) {
    throw new AppError(
      409,
      "snapshot_target_limit",
      "A workspace can track history for up to 20 sites. Stop tracking one first.",
    );
  }
  if (e?.code === "23505" && message.includes("backlink_snapshot_targets_unique")) {
    throw new AppError(409, "already_tracked", "This site's history is already tracked.");
  }
  throw unavailable();
}

function normalizeTrackedTarget(target: string, scope: "domain" | "subdomains") {
  const normalized = normalizeBacklinksTarget(target, { scope });
  if (normalized.scope !== scope || normalized.path !== "") {
    throw new AppError(400, "invalid_target", "Enter a domain to track backlink history.");
  }
  return normalized;
}

export async function createSnapshotTarget(
  admin: SupabaseClient,
  input: {
    brandKey: string;
    id?: string;
    target: string;
    scope: "domain" | "subdomains";
    interval: "weekly" | "monthly";
    label?: string;
    approvedMaxUsd: number;
    approvalId?: string | null;
    createdBy?: string | null;
    nextRunAt: string;
  },
): Promise<SnapshotTarget> {
  const normalized = normalizeTrackedTarget(input.target, input.scope);
  const row = {
    ...(input.id ? { id: input.id } : {}),
    brand_key: input.brandKey,
    target: normalized.apiTarget,
    scope: input.scope,
    label: input.label ?? null,
    schedule_interval: input.interval,
    enabled: true,
    next_run_at: input.nextRunAt,
    approved_max_usd: input.approvedMaxUsd,
    approval_id: input.approvalId ?? null,
    created_by: input.createdBy ?? null,
    last_skip_reason: null,
    last_skip_at: null,
  };

  const { data: old, error: readError } = await admin
    .from("backlink_snapshot_targets")
    .select("id, enabled")
    .eq("brand_key", input.brandKey)
    .eq("target", normalized.apiTarget)
    .eq("scope", input.scope)
    .maybeSingle();
  if (readError) mapSnapshotError(readError);
  if (old?.enabled) {
    throw new AppError(409, "already_tracked", "This site's history is already tracked.");
  }

  const result = old
    ? await admin
        .from("backlink_snapshot_targets")
        .update(row)
        .eq("id", old.id)
        .eq("brand_key", input.brandKey)
        .select("*")
        .single()
    : await admin.from("backlink_snapshot_targets").insert(row).select("*").single();
  if (result.error || !result.data) mapSnapshotError(result.error);
  return result.data as SnapshotTarget;
}

export async function deleteSnapshotTarget(
  admin: SupabaseClient,
  brandKey: string,
  targetId: string,
): Promise<void> {
  const { data, error } = await admin
    .from("backlink_snapshot_targets")
    .update({ enabled: false })
    .eq("brand_key", brandKey)
    .eq("id", targetId)
    .select("id")
    .maybeSingle();
  if (error) mapSnapshotError(error);
  if (!data) {
    throw new AppError(404, "snapshot_target_not_found", "This tracked target does not exist.");
  }
}

export async function listSnapshotTargets(
  admin: SupabaseClient,
  brandKey: string,
): Promise<SnapshotTarget[]> {
  const { data, error } = await admin
    .from("backlink_snapshot_targets")
    .select("*")
    .eq("brand_key", brandKey)
    .eq("enabled", true)
    .order("next_run_at", { ascending: true });
  if (error) mapSnapshotError(error);
  return (data ?? []) as SnapshotTarget[];
}

export async function listSnapshots(
  admin: SupabaseClient,
  input: { brandKey: string; target: string; scope: "domain" | "subdomains" },
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeTrackedTarget(input.target, input.scope);
  const { data, error } = await admin
    .from("backlink_snapshots")
    .select("*")
    .eq("brand_key", input.brandKey)
    .eq("target", normalized.apiTarget)
    .eq("scope", input.scope)
    .order("captured_on", { ascending: false })
    .limit(120);
  if (error) mapSnapshotError(error);
  return (data ?? []).reverse().map((row: any) => ({
    capturedOn: typeof row.captured_on === "string" ? row.captured_on : new Date(row.captured_on).toISOString().slice(0, 10),
    capturedAt: row.captured_at,
    source: row.source,
    rank: row.rank,
    backlinks: row.backlinks,
    referringDomains: row.referring_domains,
    referringPages: row.referring_pages,
    brokenBacklinks: row.broken_backlinks,
    brokenPages: row.broken_pages,
    newBacklinks: row.new_backlinks,
    lostBacklinks: row.lost_backlinks,
    newReferringDomains: row.new_referring_domains,
    lostReferringDomains: row.lost_referring_domains,
    backlinksSpamScore: row.backlinks_spam_score,
    targetSpamScore: row.target_spam_score,
  }));
}

function snapshotFields(summary: BacklinksSummaryItem) {
  const n = (value: unknown) => (typeof value === "number" ? value : null);
  const info = summary.info;
  return {
    rank: n(summary.rank),
    backlinks: n(summary.backlinks),
    referring_domains: n(summary.referring_domains),
    referring_pages: n(summary.referring_pages),
    broken_backlinks: n(summary.broken_backlinks),
    broken_pages: n(summary.broken_pages),
    new_backlinks: n(summary.new_backlinks),
    lost_backlinks: n(summary.lost_backlinks),
    new_referring_domains: n(summary.new_referring_domains ?? summary.new_reffering_domains),
    lost_referring_domains: n(summary.lost_referring_domains ?? summary.lost_reffering_domains),
    backlinks_spam_score: n(summary.backlinks_spam_score),
    target_spam_score: n(info?.target_spam_score),
  };
}

export async function recordSnapshot(
  admin: SupabaseClient,
  input: {
    brandKey: string;
    target: string;
    scope: "domain" | "subdomains";
    source: "scheduled" | "lookup";
    summary: BacklinksSummaryItem;
    capturedAt: Date;
  },
): Promise<void> {
  const normalized = normalizeTrackedTarget(input.target, input.scope);
  const { error } = await admin.from("backlink_snapshots").upsert(
    {
      brand_key: input.brandKey,
      target: normalized.apiTarget,
      scope: input.scope,
      captured_on: input.capturedAt.toISOString().slice(0, 10),
      captured_at: input.capturedAt.toISOString(),
      source: input.source,
      ...snapshotFields(input.summary),
    },
    { onConflict: "brand_key,target,scope,captured_on", ignoreDuplicates: true },
  );
  if (error) mapSnapshotError(error);
}

export async function recordLookupSnapshot(
  admin: SupabaseClient,
  input: {
    brandKey: string;
    target: string;
    scope: "domain" | "subdomains";
    overview: BacklinksOverviewResult;
    now?: Date;
  },
): Promise<boolean> {
  const normalized = normalizeTrackedTarget(input.target, input.scope);
  const { data, error } = await admin
    .from("backlink_snapshot_targets")
    .select("id")
    .eq("brand_key", input.brandKey)
    .eq("target", normalized.apiTarget)
    .eq("scope", input.scope)
    .eq("enabled", true)
    .maybeSingle();
  if (error) mapSnapshotError(error);
  if (!data) return false;
  await recordSnapshot(admin, {
    brandKey: input.brandKey,
    target: normalized.apiTarget,
    scope: input.scope,
    source: "lookup",
    summary: {
      target: input.overview.target,
      ...input.overview.summary,
      info: { target_spam_score: input.overview.summary.targetSpamScore },
      new_referring_domains: input.overview.summary.newReferringDomains,
      lost_referring_domains: input.overview.summary.lostReferringDomains,
    } as BacklinksSummaryItem,
    capturedAt: input.now ?? new Date(),
  });
  return true;
}

export async function listDueSnapshotTargets(
  admin: SupabaseClient,
  now: Date,
  limit = 20,
): Promise<DueSnapshotTarget[]> {
  const { data, error } = await admin
    .from("backlink_snapshot_targets")
    .select("id,brand_key,target,scope,schedule_interval,next_run_at,approved_max_usd,customer_brands!inner(is_active)")
    .eq("enabled", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);
  if (error) mapSnapshotError(error);
  return (data ?? []).map((row: any) => ({
    key: row.id,
    observedNextRunAt: new Date(row.next_run_at).toISOString(),
    interval: row.schedule_interval as ScheduleInterval,
    brandKey: row.brand_key,
    target: row.target,
    scope: row.scope,
    approvedMaxUsd: Number(row.approved_max_usd),
    workspaceActive: row.customer_brands?.is_active === true,
  }));
}

export async function advanceSnapshotTarget(
  admin: SupabaseClient,
  item: DueSnapshotTarget,
  plan: { next: string; run: string },
  now: Date,
): Promise<boolean> {
  const { data, error } = await admin
    .from("backlink_snapshot_targets")
    .update({ next_run_at: plan.next, last_run_at: now.toISOString(), last_skip_reason: null, last_skip_at: null })
    .eq("id", item.key)
    .eq("brand_key", item.brandKey)
    .eq("next_run_at", item.observedNextRunAt)
    .select("id")
    .maybeSingle();
  if (error) mapSnapshotError(error);
  return Boolean(data);
}

export async function blockSnapshotTarget(
  admin: SupabaseClient,
  item: DueSnapshotTarget,
  plan: { next: string },
  reason: string,
  now: Date,
): Promise<void> {
  const { error } = await admin
    .from("backlink_snapshot_targets")
    .update({ next_run_at: plan.next, last_skip_reason: reason.slice(0, 64), last_skip_at: now.toISOString() })
    .eq("id", item.key)
    .eq("brand_key", item.brandKey);
  if (error) mapSnapshotError(error);
}

export type SnapshotScheduleDeps = {
  isFeatureEnabled?: typeof isFeatureEnabled;
  quote?: typeof quotePricedAction;
  isBrandActive?: (brandKey: string) => Promise<boolean>;
  now?: () => Date;
};

export async function evaluateScheduledSnapshot(
  admin: SupabaseClient,
  item: DueSnapshotTarget,
  _plan: { run: string; next: string; missed: string[] },
  deps?: SnapshotScheduleDeps,
): Promise<{ skip: string } | { start: { approvedMaxUsd: number } }> {
  const enabled = await (deps?.isFeatureEnabled ?? isFeatureEnabled)("backlink_snapshots", item.brandKey);
  if (!enabled) return { skip: "snapshots_disabled" };
  let active = item.workspaceActive;
  if (deps?.isBrandActive) active = await deps.isBrandActive(item.brandKey);
  else if (active !== true) {
    const { data, error } = await admin.from("customer_brands").select("is_active").eq("brand_key", item.brandKey).maybeSingle();
    if (error) throw unavailable();
    active = data?.is_active === true;
  }
  if (!active) return { skip: "workspace_inactive" };
  const quote = await (deps?.quote ?? quotePricedAction)(
    "backlinks.snapshots.track",
    { brandKey: item.brandKey, admin, env: process.env, now: deps?.now?.() ?? new Date() },
    { target: item.target, scope: item.scope, interval: item.interval },
  );
  if (quote.blocked) throw unavailable();
  if (quote.totalUsd > item.approvedMaxUsd) return { skip: "price_changed" };
  return { start: { approvedMaxUsd: item.approvedMaxUsd } };
}

export function snapshotSummaryFromOverview(overview: BacklinksOverviewResult): BacklinksSummaryItem {
  return {
    target: overview.target,
    rank: overview.summary.rank,
    backlinks: overview.summary.backlinks,
    referring_pages: overview.summary.referringPages,
    referring_domains: overview.summary.referringDomains,
    broken_backlinks: overview.summary.brokenBacklinks,
    broken_pages: overview.summary.brokenPages,
    new_backlinks: overview.summary.newBacklinks,
    lost_backlinks: overview.summary.lostBacklinks,
    new_referring_domains: overview.summary.newReferringDomains,
    lost_referring_domains: overview.summary.lostReferringDomains,
    backlinks_spam_score: overview.summary.backlinksSpamScore,
    info: { target_spam_score: overview.summary.targetSpamScore },
  };
}
