// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/rank-tracking.ts, src/types/schemas/rank-tracking.ts,
//   src/client/features/rank-tracking/RankTrackingTableParts.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { formatLocationLabel } from "./keyword-locations.ts";
import { scheduleTimeSchema } from "./schedule.ts";

export const KEYWORDS_PER_BATCH = 10;
export const RETRY_ROUNDS = 2;
export const SECONDS_PER_BATCH = 6;
export const MAX_KEYWORDS_PER_CONFIG = 1000;
export const MAX_TRACKED_KEYWORD_LENGTH = 200;
export const MAX_CONFIGS_PER_WORKSPACE = 500;
export const RETRY_DROP_POSITIONS = 10;

export const DEVICES = ["both", "desktop", "mobile"] as const;
export type Devices = (typeof DEVICES)[number];
export const RANK_SCHEDULES = ["daily", "weekly", "monthly", "manual"] as const;
export type RankSchedule = (typeof RANK_SCHEDULES)[number];
export const COMPARE_PERIODS = ["1d", "7d", "30d", "90d"] as const;
export type ComparePeriod = (typeof COMPARE_PERIODS)[number];
export const COMPARE_PERIOD_DAYS: Record<ComparePeriod, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const COMPARE_LABELS: Record<ComparePeriod, string> = {
  "1d": "vs yesterday",
  "7d": "vs last week",
  "30d": "vs last month",
  "90d": "vs 90 days ago",
};

export function defaultComparePeriod(schedule: RankSchedule): ComparePeriod {
  return schedule === "daily" ? "1d" : schedule === "monthly" ? "30d" : "7d";
}

export function devicesCount(devices: Devices): 1 | 2 {
  return devices === "both" ? 2 : 1;
}

export function devicesLabel(devices: Devices): "Desktop + Mobile" | "Desktop" | "Mobile" {
  return devices === "both" ? "Desktop + Mobile" : devices === "desktop" ? "Desktop" : "Mobile";
}

export function rankScheduleLabel(schedule: RankSchedule): string {
  return schedule === "manual" ? "Manual" : `${schedule[0].toUpperCase()}${schedule.slice(1)}`;
}

export function pagesToDepth(pages: number): number {
  return Math.min(100, Math.max(10, Math.round(pages) * 10));
}

export function expandDevices(devices: Devices): Array<"desktop" | "mobile"> {
  return devices === "both" ? ["desktop", "mobile"] : [devices];
}

export type RankDeviceResult = {
  position: number | null;
  previousPosition: number | null;
  rankingUrl: string | null;
  serpFeatures: string[];
  checkedAt: string | null;
};

export type RankAiQuestion = {
  questionId: string;
  status: "cited" | "mentioned" | "absent" | "no_overview" | "not_measured";
  measuredAt: string | null;
};

export type RankTrackingRow = {
  trackingKeywordId: string;
  keyword: string;
  matchCase: boolean;
  pinned: boolean;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  desktop: RankDeviceResult;
  mobile: RankDeviceResult;
  aiQuestion: RankAiQuestion | null;
};

export const RANK_SKIP_REASONS = [
  "no_keywords",
  "approval_missing",
  "price_changed",
  "rank_tracking_disabled",
  "workspace_inactive",
  "daily_cap",
  "workspace_cap",
  "feature_disabled",
  "start_failed",
] as const;

const RANK_SKIP_MESSAGES: Record<(typeof RANK_SKIP_REASONS)[number], string> = {
  no_keywords: "No keywords to check. Add keywords to resume scheduled checks.",
  approval_missing: "Approve the price of scheduled checks to start them.",
  price_changed: "Scheduled checks now cost more than you approved. Review the price to resume.",
  rank_tracking_disabled: "Rank tracking is turned off for this workspace.",
  workspace_inactive: "This workspace is inactive.",
  daily_cap: "Today's spend limit for this workspace was reached.",
  workspace_cap: "This month's spend limit for this workspace was reached.",
  feature_disabled: "Rank checks are not enabled for this workspace.",
  start_failed: "The scheduled check could not start.",
};

export function rankSkipReasonMessage(reason: string): string {
  return RANK_SKIP_MESSAGES[reason as keyof typeof RANK_SKIP_MESSAGES] ?? "The scheduled check could not start.";
}

export const SERP_FEATURE_SHORT_LABELS: Record<string, string> = {
  featured_snippet: "FS",
  people_also_ask: "PAA",
  ai_overview: "AI",
  local_pack: "Local",
  knowledge_panel: "KP",
  video: "Video",
  images: "Img",
  shopping: "Shop",
  top_stories: "News",
};

export const SERP_FEATURE_TOOLTIPS: Record<string, string> = {
  featured_snippet: "Featured Snippet — highlighted answer box at top of results",
  people_also_ask: "People Also Ask — expandable related questions",
  ai_overview: "AI Overview: Google showed an AI-generated summary on this results page when we checked. Overviews that load after the page are not detected here.",
  local_pack: "Local Pack — map with local business listings",
  knowledge_panel: "Knowledge Panel — info box about an entity",
  video: "Video — video results shown in the SERP",
  images: "Images — image results shown in the SERP",
  shopping: "Shopping — product listings with prices",
  top_stories: "Top Stories — news articles carousel",
};

export function csvChange(current: number | null, previous: number | null): number | string {
  if (previous === null) return current !== null ? "new" : "";
  if (current === null) return "lost";
  return previous - current;
}

export function buildRankTrackingExport(
  rows: RankTrackingRow[],
  showDesktop: boolean,
  showMobile: boolean,
  locationLabel?: string | null,
): { headers: string[]; rows: (string | number)[][] } {
  const headers = [
    "Keyword",
    locationLabel ? `Local volume (${formatLocationLabel(locationLabel, 2)})` : "Volume",
    "KD",
    "CPC",
    ...(showDesktop ? ["Desktop Position", "Desktop Change", "Desktop URL", "Desktop SERP Features"] : []),
    ...(showMobile ? ["Mobile Position", "Mobile Change", "Mobile URL", "Mobile SERP Features"] : []),
    "AI Overview",
  ];
  const exportedRows = rows.map((row) => [
    row.keyword,
    row.searchVolume ?? "",
    row.keywordDifficulty ?? "",
    row.cpc ?? "",
    ...(showDesktop
      ? [row.desktop.position ?? "", csvChange(row.desktop.position, row.desktop.previousPosition), row.desktop.rankingUrl ?? "", row.desktop.serpFeatures.join(", ")]
      : []),
    ...(showMobile
      ? [row.mobile.position ?? "", csvChange(row.mobile.position, row.mobile.previousPosition), row.mobile.rankingUrl ?? "", row.mobile.serpFeatures.join(", ")]
      : []),
    [...row.desktop.serpFeatures, ...row.mobile.serpFeatures].includes("ai_overview") ? "yes" : "",
  ]);
  return { headers, rows: exportedRows };
}

export { scheduleTimeSchema as rankScheduleTimeSchema };
