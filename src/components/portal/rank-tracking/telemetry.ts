// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/lib/posthog.ts (rank-tracking event names)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

export type RankEventName =
  | "rank_tracking:config_create"
  | "rank_tracking:keywords_add"
  | "rank_tracking:check_trigger"
  | "rank_tracking:check_complete"
  | "rank_tracking:pin"
  | "rank_tracking:metrics_refresh"
  | "rank_tracking:suggestions_open"
  | "rank_tracking:export_csv"
  | "rank_tracking:track_question";

export type RankEventTracker = (
  event: RankEventName,
  properties?: Record<string, any>,
) => void;

let tracker: RankEventTracker | null = null;

/**
 * Registers the analytics sink. F26 wires it; until then events are dropped.
 * Payloads carry counts and options only — never keyword text, domains or URLs.
 */
export function setRankEventTracker(fn: RankEventTracker | null): void {
  tracker = fn;
}

export function trackRankEvent(
  event: RankEventName,
  properties?: Record<string, any>,
): void {
  tracker?.(event, properties);
}

// ---------------------------------------------------------------------------
// Typed payload builders (§6.7)
// Every builder emits ONLY permitted non-PII keys.
// ---------------------------------------------------------------------------

export interface ConfigCreatePayload {
  [key: string]: string | boolean;
  devices: string;
  schedule: string;
  local: boolean;
}

export function buildConfigCreatePayload(input: {
  devices: string;
  schedule: string;
  local: boolean;
}): ConfigCreatePayload {
  return {
    devices: String(input.devices),
    schedule: String(input.schedule),
    local: Boolean(input.local),
  };
}

export interface KeywordsAddPayload {
  count: number;
  source: string;
}

export function buildKeywordsAddPayload(input: {
  count: number;
  source: string;
}): KeywordsAddPayload {
  return {
    count: Number(input.count),
    source: String(input.source),
  };
}

export interface CheckTriggerPayload {
  keywords: number;
  subset: boolean;
}

export function buildCheckTriggerPayload(input: {
  keywords: number;
  subset: boolean;
}): CheckTriggerPayload {
  return {
    keywords: Number(input.keywords),
    subset: Boolean(input.subset),
  };
}

export interface CheckCompletePayload {
  status: string;
  trigger: string;
  keywords_checked: number;
}

export function buildCheckCompletePayload(input: {
  status: string;
  trigger: string;
  keywords_checked: number;
}): CheckCompletePayload {
  return {
    status: String(input.status),
    trigger: String(input.trigger),
    keywords_checked: Number(input.keywords_checked),
  };
}

export interface PinPayload {
  pinned: boolean;
}

export function buildPinPayload(input: {
  pinned: boolean;
}): PinPayload {
  return {
    pinned: Boolean(input.pinned),
  };
}

export interface MetricsRefreshPayload {
  bought: number;
  from_cache: number;
}

export function buildMetricsRefreshPayload(input: {
  bought: number;
  from_cache: number;
}): MetricsRefreshPayload {
  return {
    bought: Number(input.bought),
    from_cache: Number(input.from_cache),
  };
}

export interface SuggestionsOpenPayload {
  cached: boolean;
  count: number;
}

export function buildSuggestionsOpenPayload(input: {
  cached: boolean;
  count: number;
}): SuggestionsOpenPayload {
  return {
    cached: Boolean(input.cached),
    count: Number(input.count),
  };
}

export interface ExportCsvPayload {
  scope: string;
}

export function buildExportCsvPayload(input: {
  scope?: string;
}): ExportCsvPayload {
  return {
    scope: input.scope ? String(input.scope) : "all",
  };
}

export interface TrackQuestionPayload {
  created: boolean;
}

export function buildTrackQuestionPayload(input: {
  created: boolean;
}): TrackQuestionPayload {
  return {
    created: Boolean(input.created),
  };
}
