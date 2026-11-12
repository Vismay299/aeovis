// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/domain.ts
//   src/client/features/domain/domainRouteState.ts
//   src/client/features/domain/domainFilterUtils.ts
//   src/client/features/domain/utils.ts
//   src/client/features/domain/types.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import {
  defaultScopeForPath,
  isScopeAllowedForInput,
  parseResearchTarget,
  researchScopeSchema,
  type ResearchScope,
} from "./researchScope.ts";
import {
  DEFAULT_LOCATION_CODE,
  isLabsLocationCode,
} from "./keyword-locations.ts";

export const DOMAIN_SORT_MODES = [
  "rank",
  "traffic",
  "volume",
  "score",
  "cpc",
] as const;
export type DomainSortMode = (typeof DOMAIN_SORT_MODES)[number];

export const DOMAIN_TABS = ["keywords", "pages", "competitors"] as const;
export type DomainTab = (typeof DOMAIN_TABS)[number];

export const DOMAIN_PAGE_SIZES = [50, 100, 200] as const;
export type DomainPageSize = (typeof DOMAIN_PAGE_SIZES)[number];
export const DEFAULT_DOMAIN_PAGE_SIZE: DomainPageSize = 50;

export type SortOrder = "asc" | "desc";

export const KEYWORD_FILTER_FIELDS = [
  "include",
  "exclude",
  "minTraffic",
  "maxTraffic",
  "minVol",
  "maxVol",
  "minCpc",
  "maxCpc",
  "minKd",
  "maxKd",
  "minRank",
  "maxRank",
] as const;
export type KeywordFilterKey = (typeof KEYWORD_FILTER_FIELDS)[number];

export const PAGE_FILTER_FIELDS = [
  "include",
  "exclude",
  "minTraffic",
  "maxTraffic",
  "minVol",
  "maxVol",
] as const;
export type PageFilterKey = (typeof PAGE_FILTER_FIELDS)[number];

export const PAGE_SEARCH_PARAM_BY_FIELD = {
  include: "pInclude",
  exclude: "pExclude",
  minTraffic: "pMinTraffic",
  maxTraffic: "pMaxTraffic",
  minVol: "pMinVol",
  maxVol: "pMaxVol",
} as const;

export type KeywordsFilterValues = {
  include: string;
  exclude: string;
  minTraffic: string;
  maxTraffic: string;
  minVol: string;
  maxVol: string;
  minCpc: string;
  maxCpc: string;
  minKd: string;
  maxKd: string;
  minRank: string;
  maxRank: string;
};

export type PagesFilterValues = {
  include: string;
  exclude: string;
  minTraffic: string;
  maxTraffic: string;
  minVol: string;
  maxVol: string;
};

export type DomainFilterValues = KeywordsFilterValues;

export const EMPTY_DOMAIN_FILTERS: KeywordsFilterValues = {
  include: "",
  exclude: "",
  minTraffic: "",
  maxTraffic: "",
  minVol: "",
  maxVol: "",
  minCpc: "",
  maxCpc: "",
  minKd: "",
  maxKd: "",
  minRank: "",
  maxRank: "",
};

export const EMPTY_PAGE_FILTERS: PagesFilterValues = {
  include: "",
  exclude: "",
  minTraffic: "",
  maxTraffic: "",
  minVol: "",
  maxVol: "",
};

const optionalNumber = z
  .union([
    z.number(),
    z.string().transform((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed === "") return undefined;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: "custom", message: "Invalid number" });
        return z.NEVER;
      }
      return parsed;
    }),
  ])
  .optional();

export const domainKeywordsFiltersSchema = z.object({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minTraffic: optionalNumber,
  maxTraffic: optionalNumber,
  minVol: optionalNumber,
  maxVol: optionalNumber,
  minCpc: optionalNumber,
  maxCpc: optionalNumber,
  minKd: optionalNumber,
  maxKd: optionalNumber,
  minRank: optionalNumber,
  maxRank: optionalNumber,
});

export type DomainKeywordsFilters = z.infer<typeof domainKeywordsFiltersSchema>;

export const booleanSearchParamSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const optionalSearchNumberParam = z.coerce
  .number()
  .optional()
  .catch(undefined);
export const optionalSearchPositiveIntParam = z.coerce
  .number()
  .int()
  .positive()
  .optional()
  .catch(undefined);
const filterStringParam = z.string().optional();
const filterNumberParam = optionalSearchNumberParam;

export const domainSearchSchema = z.object({
  domain: z.string().optional(),
  scope: researchScopeSchema.optional().catch(undefined),
  subdomains: booleanSearchParamSchema.optional(),
  sort: z.enum(DOMAIN_SORT_MODES).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  tab: z.enum(DOMAIN_TABS).optional(),
  loc: optionalSearchPositiveIntParam,
  page: optionalSearchPositiveIntParam,
  size: z.coerce
    .number()
    .int()
    .refine((value) =>
      (DOMAIN_PAGE_SIZES as readonly number[]).includes(value as any),
    )
    .optional()
    .catch(undefined),
  include: filterStringParam,
  exclude: filterStringParam,
  minTraffic: filterNumberParam,
  maxTraffic: filterNumberParam,
  minVol: filterNumberParam,
  maxVol: filterNumberParam,
  minCpc: filterNumberParam,
  maxCpc: filterNumberParam,
  minKd: filterNumberParam,
  maxKd: filterNumberParam,
  minRank: filterNumberParam,
  maxRank: filterNumberParam,
  pInclude: filterStringParam,
  pExclude: filterStringParam,
  pMinTraffic: filterNumberParam,
  pMaxTraffic: filterNumberParam,
  pMinVol: filterNumberParam,
  pMaxVol: filterNumberParam,
});

export type DomainSearchParams = z.infer<typeof domainSearchSchema>;

export const DOMAIN_SEARCH_DEFAULTS: DomainSearchParams = {
  domain: "",
  scope: undefined,
  subdomains: undefined,
  sort: undefined,
  order: undefined,
  tab: undefined,
  loc: undefined,
  page: undefined,
  size: undefined,
  include: undefined,
  exclude: undefined,
  minTraffic: undefined,
  maxTraffic: undefined,
  minVol: undefined,
  maxVol: undefined,
  minCpc: undefined,
  maxCpc: undefined,
  minKd: undefined,
  maxKd: undefined,
  minRank: undefined,
  maxRank: undefined,
  pInclude: undefined,
  pExclude: undefined,
  pMinTraffic: undefined,
  pMaxTraffic: undefined,
  pMinVol: undefined,
  pMaxVol: undefined,
};

export type DomainOverviewRouteState = {
  domain: string;
  scope: ResearchScope;
  sort: DomainSortMode;
  order: SortOrder;
  tab: DomainTab;
  defaultLocationCode: number;
  locationCode: number;
  sentLocationCode: number | undefined;
  page: number;
  pageSize: number;
  appliedFilters: DomainFilterValues;
  appliedPageFilters: PagesFilterValues;
  hasAppliedKeywordFilters: boolean;
  hasAppliedPageFilters: boolean;
};

export function getDefaultSortOrder(sortMode: DomainSortMode): SortOrder {
  return sortMode === "rank" ? "asc" : "desc";
}

export function toSortMode(value: string | null | undefined): DomainSortMode | undefined {
  if (
    value === "rank" ||
    value === "traffic" ||
    value === "volume" ||
    value === "score" ||
    value === "cpc"
  ) {
    return value;
  }
  return undefined;
}

export function toSortOrder(value: string | null | undefined): SortOrder | undefined {
  if (value === "asc" || value === "desc") return value;
  return undefined;
}

export function resolveSortOrder(
  sortMode: DomainSortMode,
  sortOrder: SortOrder | undefined,
): SortOrder {
  return sortOrder ?? getDefaultSortOrder(sortMode);
}

export function toSortSearchParam(
  sortMode: DomainSortMode,
): DomainSortMode | undefined {
  return sortMode === "traffic" ? undefined : sortMode;
}

export function toSortOrderSearchParam(
  sortMode: DomainSortMode,
  sortOrder: SortOrder,
): SortOrder | undefined {
  return sortOrder === getDefaultSortOrder(sortMode) ? undefined : sortOrder;
}

export function toPageSortMode(
  sortMode: DomainSortMode,
): "traffic" | "keywords" {
  if (sortMode === "volume") return "keywords";
  return "traffic";
}

export function getResearchInputPath(input: string): string {
  const parsed = parseResearchTarget(input);
  return parsed.ok ? parsed.target.path : "";
}

function resolveScope(search: DomainSearchParams): ResearchScope {
  const path = getResearchInputPath(search.domain ?? "");
  if (search.scope && isScopeAllowedForInput(search.scope, path)) {
    return search.scope;
  }
  if (search.subdomains != null) {
    return search.subdomains ? "subdomains" : "domain";
  }
  return defaultScopeForPath(path);
}

function numberToFilterString(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(value);
}

export function getDomainRouteState(
  search: DomainSearchParams,
  marketOrDefault?: number | { locationCode: number; languageCode?: string },
): DomainOverviewRouteState {
  const normalizedSort = toSortMode(search.sort) ?? "traffic";

  let defaultLocationCode = DEFAULT_LOCATION_CODE;
  if (typeof marketOrDefault === "number") {
    if (isLabsLocationCode(marketOrDefault)) {
      defaultLocationCode = marketOrDefault;
    }
  } else if (marketOrDefault && typeof marketOrDefault.locationCode === "number") {
    if (isLabsLocationCode(marketOrDefault.locationCode)) {
      defaultLocationCode = marketOrDefault.locationCode;
    }
  }

  const normalizedLocationCode =
    search.loc != null && isLabsLocationCode(search.loc)
      ? search.loc
      : defaultLocationCode;

  return {
    domain: search.domain ?? "",
    scope: resolveScope(search),
    sort: normalizedSort,
    order: resolveSortOrder(normalizedSort, toSortOrder(search.order)),
    tab: search.tab ?? "keywords",
    defaultLocationCode,
    locationCode: normalizedLocationCode,
    sentLocationCode:
      search.loc != null && isLabsLocationCode(search.loc)
        ? search.loc
        : undefined,
    page: search.page != null && search.page > 0 ? search.page : 1,
    pageSize: search.size ?? DEFAULT_DOMAIN_PAGE_SIZE,
    appliedFilters: {
      include: search.include ?? EMPTY_DOMAIN_FILTERS.include,
      exclude: search.exclude ?? EMPTY_DOMAIN_FILTERS.exclude,
      minTraffic: numberToFilterString(search.minTraffic),
      maxTraffic: numberToFilterString(search.maxTraffic),
      minVol: numberToFilterString(search.minVol),
      maxVol: numberToFilterString(search.maxVol),
      minCpc: numberToFilterString(search.minCpc),
      maxCpc: numberToFilterString(search.maxCpc),
      minKd: numberToFilterString(search.minKd),
      maxKd: numberToFilterString(search.maxKd),
      minRank: numberToFilterString(search.minRank),
      maxRank: numberToFilterString(search.maxRank),
    },
    appliedPageFilters: {
      include: search.pInclude ?? EMPTY_PAGE_FILTERS.include,
      exclude: search.pExclude ?? EMPTY_PAGE_FILTERS.exclude,
      minTraffic: numberToFilterString(search.pMinTraffic),
      maxTraffic: numberToFilterString(search.pMaxTraffic),
      minVol: numberToFilterString(search.pMinVol),
      maxVol: numberToFilterString(search.pMaxVol),
    },
    hasAppliedKeywordFilters: hasKeywordSearchFilters(search),
    hasAppliedPageFilters: hasPageSearchFilters(search),
  };
}

function hasKeywordSearchFilters(search: DomainSearchParams): boolean {
  return KEYWORD_FILTER_FIELDS.some(
    (key) => (search as any)[key] != null,
  );
}

function hasPageSearchFilters(search: DomainSearchParams): boolean {
  return PAGE_FILTER_FIELDS.some(
    (key) => (search as any)[PAGE_SEARCH_PARAM_BY_FIELD[key]] != null,
  );
}

export function countKeywordFilterConditions(
  values: KeywordsFilterValues,
): number {
  return countFilterConditions(values, KEYWORD_FILTER_FIELDS);
}

export function countPageFilterConditions(values: PagesFilterValues): number {
  return countFilterConditions(values, PAGE_FILTER_FIELDS);
}

function countFilterConditions<TValues extends Record<string, string>>(
  values: TValues,
  fields: ReadonlyArray<keyof TValues>,
): number {
  let n = 0;
  if (values.include) {
    for (const term of values.include.split(/[,+]/)) if (term.trim()) n += 1;
  }
  if (values.exclude) {
    for (const term of values.exclude.split(/[,+]/)) if (term.trim()) n += 1;
  }
  for (const key of fields) {
    if (key === "include" || key === "exclude") continue;
    if (values[key] && values[key].trim() !== "") n += 1;
  }
  return n;
}

type SearchUpdate = Partial<DomainSearchParams>;
type FilterValues = Record<string, string>;
type FilterKey<TValues extends FilterValues> = Extract<keyof TValues, string>;

function buildFilterSearchUpdate<TValues extends FilterValues>(
  values: TValues,
  fields: ReadonlyArray<FilterKey<TValues>>,
  getParam: (key: FilterKey<TValues>) => keyof DomainSearchParams,
): SearchUpdate {
  const update: SearchUpdate = { page: undefined };
  for (const key of fields) {
    const param = getParam(key);
    const raw = (values[key] ?? "").trim();
    if (raw === "") {
      Object.assign(update, { [param]: undefined });
      continue;
    }
    if (key === "include" || key === "exclude") {
      Object.assign(update, { [param]: raw });
      continue;
    }
    const parsed = Number(raw);
    Object.assign(update, {
      [param]: Number.isFinite(parsed) ? parsed : undefined,
    });
  }
  return update;
}

function buildFilterClearSearchUpdate<TValues extends FilterValues>(
  fields: ReadonlyArray<FilterKey<TValues>>,
  getParam: (key: FilterKey<TValues>) => keyof DomainSearchParams,
): SearchUpdate {
  const update: SearchUpdate = { page: undefined };
  for (const key of fields) {
    Object.assign(update, { [getParam(key)]: undefined });
  }
  return update;
}

export function buildKeywordsSearchUpdate(
  values: KeywordsFilterValues,
): SearchUpdate {
  return buildFilterSearchUpdate<KeywordsFilterValues>(
    values,
    KEYWORD_FILTER_FIELDS,
    (key) => key as keyof DomainSearchParams,
  );
}

export function buildPagesSearchUpdate(
  values: PagesFilterValues,
): SearchUpdate {
  return buildFilterSearchUpdate<PagesFilterValues>(
    values,
    PAGE_FILTER_FIELDS,
    (key) => PAGE_SEARCH_PARAM_BY_FIELD[key as PageFilterKey],
  );
}

export function buildDomainFiltersClearSearchUpdate(): SearchUpdate {
  const update = buildFilterClearSearchUpdate<KeywordsFilterValues>(
    KEYWORD_FILTER_FIELDS,
    (key) => key as keyof DomainSearchParams,
  );
  Object.assign(
    update,
    buildFilterClearSearchUpdate<PagesFilterValues>(
      PAGE_FILTER_FIELDS,
      (key) => PAGE_SEARCH_PARAM_BY_FIELD[key as PageFilterKey],
    ),
  );
  return update;
}

export function buildDomainResearchHref(i: {
  domain: string;
  preset?: "striking_distance";
  locationCode?: number;
}): string {
  const params = new URLSearchParams();
  params.set("domain", i.domain);
  if (i.preset === "striking_distance") {
    params.set("minRank", "4");
    params.set("maxRank", "20");
    params.set("sort", "volume");
    params.set("order", "desc");
  }
  if (i.locationCode && isLabsLocationCode(i.locationCode) && i.locationCode !== DEFAULT_LOCATION_CODE) {
    params.set("loc", String(i.locationCode));
  }
  return `/portal/domain?${params.toString()}`;
}

export type ExportTable = { headers: string[]; rows: (string | number | null)[][] };

export function keywordsToTable(
  rows: Array<{
    keyword: string;
    position: number | null;
    searchVolume: number | null;
    traffic: number | null;
    cpc: number | null;
    url?: string | null;
    relativeUrl?: string | null;
    keywordDifficulty: number | null;
  }>,
): ExportTable {
  return {
    headers: ["Keyword", "Rank", "Volume", "Traffic", "CPC", "URL", "Score"],
    rows: rows.map((row) => [
      row.keyword,
      row.position,
      row.searchVolume,
      row.traffic,
      row.cpc,
      row.url ?? row.relativeUrl ?? null,
      row.keywordDifficulty,
    ]),
  };
}

export function pagesToTable(
  rows: Array<{
    page: string;
    organicTraffic: number | null;
    keywords: number | null;
  }>,
): ExportTable {
  return {
    headers: ["Page", "Organic Traffic", "Keywords"],
    rows: rows.map((row) => [row.page, row.organicTraffic, row.keywords]),
  };
}

export function competitorsToTable(
  rows: Array<{
    domain: string;
    keywordsCount: number;
    avgPosition: number;
    visibility: number;
    etv: number;
  }>,
): ExportTable {
  return {
    headers: [
      "Domain",
      "Shared Keywords",
      "Avg. Position",
      "Visibility",
      "Estimated Traffic",
    ],
    rows: rows.map((row) => [
      row.domain,
      row.keywordsCount,
      row.avgPosition,
      row.visibility,
      row.etv,
    ]),
  };
}
