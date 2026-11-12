// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingFilters.logic.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { LOCATION_OPTIONS } from "./keyword-locations.ts";
import { devicesLabel } from "./rank-tracking.ts";
import type { Devices, RankTrackingRow } from "./rank-tracking.ts";

export type Filters = {
  include: string;
  exclude: string;
  minDesktopPos: string;
  maxDesktopPos: string;
  minMobilePos: string;
  maxMobilePos: string;
  minVolume: string;
  maxVolume: string;
  minKd: string;
  maxKd: string;
  minCpc: string;
  maxCpc: string;
  aiOverview: "any" | "shown" | "not_seen";
};

type DomainFilterableConfig = { domain: string; devices: Devices; locationCode: number };
export type DomainListFilters = { query: string; device: "all" | Devices; locationCode: string };
type DomainListFilterOption = { value: string; label: string };

export const EMPTY_FILTERS: Filters = {
  include: "", exclude: "", minDesktopPos: "", maxDesktopPos: "", minMobilePos: "", maxMobilePos: "",
  minVolume: "", maxVolume: "", minKd: "", maxKd: "", minCpc: "", maxCpc: "", aiOverview: "any",
};
export const EMPTY_DOMAIN_LIST_FILTERS: DomainListFilters = { query: "", device: "all", locationCode: "all" };

const DEVICE_FILTER_ORDER: Devices[] = ["both", "desktop", "mobile"];

export function applyDomainListFilters<T extends DomainFilterableConfig>(configs: T[], filters: DomainListFilters): T[] {
  const query = filters.query.trim().toLowerCase();
  const locationCode = filters.locationCode === "all" ? null : Number(filters.locationCode);
  return configs.filter((config) =>
    (!query || config.domain.toLowerCase().includes(query)) &&
    (filters.device === "all" || config.devices === filters.device) &&
    (locationCode === null || config.locationCode === locationCode),
  );
}

export function getDomainListFilterOptions(configs: DomainFilterableConfig[]): {
  devices: DomainListFilterOption[];
  locations: DomainListFilterOption[];
} {
  const deviceValues = new Set(configs.map((config) => config.devices));
  const devices = DEVICE_FILTER_ORDER.filter((device) => deviceValues.has(device)).map((device) => ({
    value: device,
    label: devicesLabel(device),
  }));
  const locationMap = new Map<number, string>();
  for (const config of configs) {
    locationMap.set(config.locationCode, LOCATION_OPTIONS.find((option) => option.code === config.locationCode)?.label ?? String(config.locationCode));
  }
  const locations = [...locationMap].map(([code, label]) => ({ value: String(code), label })).sort((a, b) => a.label.localeCompare(b.label));
  return { devices, locations };
}

function matchesPositionFilter(position: number | null, minValue: string, maxValue: string): boolean {
  if (!minValue && !maxValue) return true;
  const max = maxValue === "" ? Infinity : Number(maxValue);
  if (max === 0) return position === null;
  if (position === null) return false;
  const min = minValue === "" ? 0 : Number(minValue);
  return position >= min && position <= max;
}

function matchesMetricRangeFilter(value: number | null, minValue: string, maxValue: string): boolean {
  if (!minValue && !maxValue) return true;
  if (value === null) return false;
  const min = minValue === "" ? -Infinity : Number(minValue);
  const max = maxValue === "" ? Infinity : Number(maxValue);
  return value >= min && value <= max;
}

export function applyFilters(
  rows: RankTrackingRow[],
  filters: Filters,
  visibleDevice: "desktop" | "mobile" = "mobile",
): RankTrackingRow[] {
  const includeTerms = filters.include.toLowerCase().split(",").map((term) => term.trim()).filter(Boolean);
  const excludeTerms = filters.exclude.toLowerCase().split(",").map((term) => term.trim()).filter(Boolean);
  return rows.filter((row) => {
    const keyword = row.keyword.toLowerCase();
    if (includeTerms.length && !includeTerms.some((term) => keyword.includes(term))) return false;
    if (excludeTerms.some((term) => keyword.includes(term))) return false;
    if (!matchesPositionFilter(row.desktop.position, filters.minDesktopPos, filters.maxDesktopPos)) return false;
    if (!matchesPositionFilter(row.mobile.position, filters.minMobilePos, filters.maxMobilePos)) return false;
    if (!matchesMetricRangeFilter(row.searchVolume, filters.minVolume, filters.maxVolume)) return false;
    if (!matchesMetricRangeFilter(row.keywordDifficulty, filters.minKd, filters.maxKd)) return false;
    if (!matchesMetricRangeFilter(row.cpc, filters.minCpc, filters.maxCpc)) return false;
    if (filters.aiOverview !== "any") {
      const device = row[visibleDevice];
      if (device.checkedAt === null) return false;
      const shown = device.serpFeatures.includes("ai_overview");
      if (filters.aiOverview === "shown" && !shown) return false;
      if (filters.aiOverview === "not_seen" && shown) return false;
    }
    return true;
  });
}

export function countActiveFilters(filters: Filters): number {
  let count = 0;
  if (filters.include) count++;
  if (filters.exclude) count++;
  if (filters.minDesktopPos || filters.maxDesktopPos) count++;
  if (filters.minMobilePos || filters.maxMobilePos) count++;
  if (filters.minVolume || filters.maxVolume) count++;
  if (filters.minKd || filters.maxKd) count++;
  if (filters.minCpc || filters.maxCpc) count++;
  if (filters.aiOverview !== "any") count++;
  return count;
}

export function countActiveDomainListFilters(filters: DomainListFilters): number {
  return Number(Boolean(filters.query.trim())) + Number(filters.device !== "all") + Number(filters.locationCode !== "all");
}
