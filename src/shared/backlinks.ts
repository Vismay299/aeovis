// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/backlinks.ts
//   src/client/features/backlinks/backlinksFilterTypes.ts
//   src/client/features/backlinks/backlinksPageUtils.ts
//   src/client/features/backlinks/export.ts
//   src/client/features/backlinks/backlinksPageTypes.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import {
  BACKLINKS_SUBFOLDER_FILTER_CONDITIONS,
  MAX_DATAFORSEO_FILTER_CONDITIONS,
  RESEARCH_SCOPES,
  RESEARCH_SCOPE_PARAM_DESCRIPTION,
  type ResearchScope,
} from "./researchScope.ts";

export const BACKLINKS_TABS = ["backlinks", "domains", "pages"] as const;
export type BacklinksTab = (typeof BACKLINKS_TABS)[number];
export const backlinksTabSchema = z.enum(BACKLINKS_TABS);

export const DEFAULT_BACKLINKS_SPAM_THRESHOLD = 40;
export const BACKLINKS_PAGE_SIZES = [50, 100, 200] as const;
export const DEFAULT_BACKLINKS_PAGE_SIZE = 50;
export const BACKLINKS_DEFAULT_PAGE_SIZE = DEFAULT_BACKLINKS_PAGE_SIZE;

export type BacklinksTargetScope = ResearchScope;

export const backlinksScopeWithLegacySchema = z.enum([
  ...RESEARCH_SCOPES,
  "page",
]);

export type BacklinksScopeWithLegacy = z.infer<
  typeof backlinksScopeWithLegacySchema
>;

export function resolveBacklinksScope(
  scope: BacklinksScopeWithLegacy,
): ResearchScope {
  return scope === "page" ? "exact_url" : scope;
}

export const backlinksScopeParamSchema =
  backlinksScopeWithLegacySchema.transform(resolveBacklinksScope);

export const BACKLINKS_SCOPE_DESCRIPTION = `${RESEARCH_SCOPE_PARAM_DESCRIPTION} 'page' is a deprecated alias of 'exact_url'. Subfolder counts are computed from filtered backlink totals; rank, trends, and the referring-domains breakdown are unavailable for subfolders.`;

export type BacklinksSpamFilterOptions = {
  hideSpam?: boolean;
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

export const backlinksRowsFiltersSchema = z.object({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minDomainRank: optionalNumber,
  maxDomainRank: optionalNumber,
  minLinkAuthority: optionalNumber,
  maxLinkAuthority: optionalNumber,
  minSpamScore: optionalNumber,
  maxSpamScore: optionalNumber,
  linkType: z.enum(["dofollow", "nofollow"]).optional(),
  hideLost: z.boolean().optional(),
  hideBroken: z.boolean().optional(),
  domainFrom: z.string().max(255).optional(),
});

export const backlinksRowsModeSchema = z.enum(["one_per_domain", "as_is"]);

export const referringDomainsFiltersSchema = z.object({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minBacklinks: optionalNumber,
  maxBacklinks: optionalNumber,
  minRank: optionalNumber,
  maxRank: optionalNumber,
  minSpamScore: optionalNumber,
  maxSpamScore: optionalNumber,
});

export const topPagesFiltersSchema = z.object({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minBacklinks: optionalNumber,
  maxBacklinks: optionalNumber,
  minReferringDomains: optionalNumber,
  maxReferringDomains: optionalNumber,
  minRank: optionalNumber,
  maxRank: optionalNumber,
});

export const backlinksSortOrderSchema = z.enum(["asc", "desc"]);
export type BacklinksSortOrder = z.infer<typeof backlinksSortOrderSchema>;

export const backlinksRowsSortFieldSchema = z.enum([
  "rank",
  "domainRank",
  "spamScore",
  "firstSeen",
]);
export type BacklinksRowsSortField = z.infer<
  typeof backlinksRowsSortFieldSchema
>;

export const referringDomainsSortFieldSchema = z.enum([
  "domain",
  "backlinks",
  "referringPages",
  "rank",
  "spamScore",
  "firstSeen",
  "brokenBacklinks",
]);
export type ReferringDomainsSortField = z.infer<
  typeof referringDomainsSortFieldSchema
>;

export const topPagesSortFieldSchema = z.enum([
  "backlinks",
  "referringDomains",
  "rank",
  "brokenBacklinks",
]);
export type TopPagesSortField = z.infer<typeof topPagesSortFieldSchema>;

export const BACKLINKS_DEFAULT_SORT = {
  backlinks: { field: "firstSeen", order: "desc" },
  domains: { field: "backlinks", order: "desc" },
  pages: { field: "backlinks", order: "desc" },
} as const satisfies Record<
  BacklinksTab,
  { field: string; order: z.infer<typeof backlinksSortOrderSchema> }
>;

export const backlinksSearchSchema = z.object({
  includeSpam: z.boolean().optional().catch(undefined),
  target: z.string().optional(),
  scope: backlinksScopeParamSchema.optional().catch(undefined),
  tab: backlinksTabSchema.optional().catch(undefined),
  page: z.coerce.number().int().positive().optional().catch(undefined),
  size: z.coerce
    .number()
    .int()
    .refine((value) =>
      (BACKLINKS_PAGE_SIZES as readonly number[]).includes(value),
    )
    .optional()
    .catch(undefined),
  sort: z.string().optional().catch(undefined),
  order: backlinksSortOrderSchema.optional().catch(undefined),
  view: z.literal("all").optional().catch(undefined),
});

export type BacklinksTabFilterValues = {
  include: string;
  exclude: string;
  minDomainRank: string;
  maxDomainRank: string;
  minLinkAuthority: string;
  maxLinkAuthority: string;
  minSpamScore: string;
  maxSpamScore: string;
  linkType: string;
  hideLost: string;
  hideBroken: string;
};

export type ReferringDomainsFilterValues = {
  include: string;
  exclude: string;
  minBacklinks: string;
  maxBacklinks: string;
  minRank: string;
  maxRank: string;
  minSpamScore: string;
  maxSpamScore: string;
};

export type TopPagesFilterValues = {
  include: string;
  exclude: string;
  minBacklinks: string;
  maxBacklinks: string;
  minReferringDomains: string;
  maxReferringDomains: string;
  minRank: string;
  maxRank: string;
};

export const EMPTY_BACKLINKS_FILTERS: BacklinksTabFilterValues = {
  include: "",
  exclude: "",
  minDomainRank: "",
  maxDomainRank: "",
  minLinkAuthority: "",
  maxLinkAuthority: "",
  minSpamScore: "",
  maxSpamScore: "",
  linkType: "",
  hideLost: "",
  hideBroken: "",
};

export const EMPTY_REFERRING_DOMAINS_FILTERS: ReferringDomainsFilterValues = {
  include: "",
  exclude: "",
  minBacklinks: "",
  maxBacklinks: "",
  minRank: "",
  maxRank: "",
  minSpamScore: "",
  maxSpamScore: "",
};

export const EMPTY_TOP_PAGES_FILTERS: TopPagesFilterValues = {
  include: "",
  exclude: "",
  minBacklinks: "",
  maxBacklinks: "",
  minReferringDomains: "",
  maxReferringDomains: "",
  minRank: "",
  maxRank: "",
};

export const BACKLINKS_FILTER_FIELDS = [
  "include",
  "exclude",
  "minDomainRank",
  "maxDomainRank",
  "minLinkAuthority",
  "maxLinkAuthority",
  "minSpamScore",
  "maxSpamScore",
  "linkType",
  "hideLost",
  "hideBroken",
] as const satisfies ReadonlyArray<keyof BacklinksTabFilterValues>;

export const REFERRING_DOMAINS_FILTER_FIELDS = [
  "include",
  "exclude",
  "minBacklinks",
  "maxBacklinks",
  "minRank",
  "maxRank",
  "minSpamScore",
  "maxSpamScore",
] as const satisfies ReadonlyArray<keyof ReferringDomainsFilterValues>;

export const TOP_PAGES_FILTER_FIELDS = [
  "include",
  "exclude",
  "minBacklinks",
  "maxBacklinks",
  "minReferringDomains",
  "maxReferringDomains",
  "minRank",
  "maxRank",
] as const satisfies ReadonlyArray<keyof TopPagesFilterValues>;

export function countFilterConditions(values: Record<string, string>): number {
  let n = 0;
  for (const [key, value] of Object.entries(values)) {
    if (key === "include" || key === "exclude") {
      for (const term of value.split(/[,+]/)) if (term.trim()) n += 1;
      continue;
    }
    if (value.trim() !== "") n += 1;
  }
  return n;
}

export function backlinksFilterConditionLimit(
  scope: ResearchScope,
  hideSpam: boolean,
): number {
  return (
    MAX_DATAFORSEO_FILTER_CONDITIONS -
    (scope === "subfolder" ? BACKLINKS_SUBFOLDER_FILTER_CONDITIONS : 0) -
    (hideSpam ? 2 : 0)
  );
}

export function backlinksFilterBudgetError(
  values: BacklinksTabFilterValues,
  scope: ResearchScope,
  hideSpam: boolean,
): string | null {
  const limit = backlinksFilterConditionLimit(scope, hideSpam);
  if (countFilterConditions(values) <= limit) return null;
  return `These filters exceed the ${limit}-condition limit for this view. Remove conditions in Filters${hideSpam ? " or choose All links (spammy included) from Best links" : ""}. Your filters have been kept.`;
}

function toNumberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type BacklinksRowsFilters = z.infer<typeof backlinksRowsFiltersSchema>;
export type ReferringDomainsFilters = z.infer<
  typeof referringDomainsFiltersSchema
>;
export type TopPagesFilters = z.infer<typeof topPagesFiltersSchema>;

export function toBacklinksFiltersPayload(
  values: BacklinksTabFilterValues,
): BacklinksRowsFilters {
  return {
    include: values.include.trim() || undefined,
    exclude: values.exclude.trim() || undefined,
    minDomainRank: toNumberOrUndefined(values.minDomainRank),
    maxDomainRank: toNumberOrUndefined(values.maxDomainRank),
    minLinkAuthority: toNumberOrUndefined(values.minLinkAuthority),
    maxLinkAuthority: toNumberOrUndefined(values.maxLinkAuthority),
    minSpamScore: toNumberOrUndefined(values.minSpamScore),
    maxSpamScore: toNumberOrUndefined(values.maxSpamScore),
    linkType:
      values.linkType === "dofollow" || values.linkType === "nofollow"
        ? values.linkType
        : undefined,
    hideLost: values.hideLost === "true" ? true : undefined,
    hideBroken: values.hideBroken === "true" ? true : undefined,
  };
}

export function toReferringDomainsFiltersPayload(
  values: ReferringDomainsFilterValues,
): ReferringDomainsFilters {
  return {
    include: values.include.trim() || undefined,
    exclude: values.exclude.trim() || undefined,
    minBacklinks: toNumberOrUndefined(values.minBacklinks),
    maxBacklinks: toNumberOrUndefined(values.maxBacklinks),
    minRank: toNumberOrUndefined(values.minRank),
    maxRank: toNumberOrUndefined(values.maxRank),
    minSpamScore: toNumberOrUndefined(values.minSpamScore),
    maxSpamScore: toNumberOrUndefined(values.maxSpamScore),
  };
}

export function toTopPagesFiltersPayload(
  values: TopPagesFilterValues,
): TopPagesFilters {
  return {
    include: values.include.trim() || undefined,
    exclude: values.exclude.trim() || undefined,
    minBacklinks: toNumberOrUndefined(values.minBacklinks),
    maxBacklinks: toNumberOrUndefined(values.maxBacklinks),
    minReferringDomains: toNumberOrUndefined(values.minReferringDomains),
    maxReferringDomains: toNumberOrUndefined(values.maxReferringDomains),
    minRank: toNumberOrUndefined(values.minRank),
    maxRank: toNumberOrUndefined(values.maxRank),
  };
}

export const TAB_DESCRIPTIONS: Record<BacklinksTab, string> = {
  backlinks:
    "See the individual links pointing to your target, including source page, anchor text, and link quality signals.",
  domains:
    "View the unique domains linking to your target, grouped at the site level instead of by individual link.",
  pages:
    "See which pages on the target site attract the most backlinks and referring domains.",
};

export type BacklinksSummary = {
  rank: number | null;
  backlinks: number | null;
  referringPages: number | null;
  referringDomains: number | null;
  brokenBacklinks: number | null;
  brokenPages: number | null;
  backlinksSpamScore: number | null;
  targetSpamScore: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
};

export type BacklinksOverview = {
  status: "ok";
  target: string;
  displayTarget: string;
  scope: BacklinksTargetScope;
  summary: BacklinksSummary;
  trends: Array<{
    date: string;
    backlinks: number | null;
    referringDomains: number | null;
    rank: number | null;
  }>;
  newLostTrends: Array<{
    date: string;
    newBacklinks: number | null;
    lostBacklinks: number | null;
    newReferringDomains: number | null;
    lostReferringDomains: number | null;
  }>;
  tracked: {
    interval: "weekly" | "monthly";
    nextRunAt: string;
  } | null;
  isOwnSite: boolean;
  isDeclaredCompetitor: boolean;
  cached: boolean;
  fetchedAt: string;
  provenance: { gateway: string };
};

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat().format(Math.round(value));
}

export function formatDecimal(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toFixed(value >= 100 ? 0 : 1);
}

export function formatSpamScore(value: number | null | undefined): {
  text: string;
  unknown: boolean;
} {
  if (value == null) return { text: "—", unknown: true };
  return { text: String(Math.round(value)), unknown: false };
}

export function buildSummaryStats(data: { summary: BacklinksSummary } | undefined) {
  if (!data) return [];

  return [
    {
      label: "Backlinks",
      value: formatNumber(data.summary.backlinks),
      description: "Total links pointing to this site or page.",
    },
    {
      label: "Referring Domains",
      value: formatNumber(data.summary.referringDomains),
      description: "Unique domains linking to this site or page.",
    },
    {
      label: "Referring Pages",
      value: formatNumber(data.summary.referringPages),
      description: "Unique pages linking to this site or page.",
    },
    {
      label: "Rank",
      value: formatNumber(data.summary.rank),
      description: "DataForSEO's 0-100 authority score.",
    },
    {
      label: "Backlink Spam Score",
      value: formatDecimal(data.summary.backlinksSpamScore),
      description: "Estimated spam risk of links pointing here.",
    },
    {
      label: "Broken Backlinks",
      value: formatNumber(data.summary.brokenBacklinks),
      description: "Links pointing to broken pages here.",
    },
    {
      label: "Broken Pages",
      value: formatNumber(data.summary.brokenPages),
      description: "Broken pages here that still have backlinks.",
    },
    {
      label: "Target Spam Score",
      value: formatDecimal(data.summary.targetSpamScore),
      description: "Estimated spam risk of this site or page.",
    },
  ];
}

const ELLIPSIS = "...";

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= ELLIPSIS.length)
    return value.slice(0, Math.max(maxLength, 0));
  const sideLength = Math.floor((maxLength - ELLIPSIS.length) / 2);
  if (sideLength <= 0) {
    return `${value.slice(0, maxLength - ELLIPSIS.length)}${ELLIPSIS}`;
  }
  return `${value.slice(0, sideLength)}${ELLIPSIS}${value.slice(-sideLength)}`;
}

export function formatRelativeTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "recently";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export type BacklinksRow = {
  domainFrom: string | null;
  urlFrom: string | null;
  urlTo: string | null;
  anchor: string | null;
  itemType: string | null;
  isDofollow: boolean | null;
  relAttributes: string[];
  rank: number | null;
  domainFromRank: number | null;
  pageFromRank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  isLost: boolean;
  isBroken: boolean;
  linksCount: number | null;
};

export type ReferringDomainRow = {
  domain: string | null;
  backlinks: number | null;
  referringPages: number | null;
  rank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  brokenBacklinks: number | null;
  brokenPages: number | null;
};

export type TopPageRow = {
  page: string | null;
  backlinks: number | null;
  referringDomains: number | null;
  rank: number | null;
  brokenBacklinks: number | null;
};

export type BacklinksSnapshot = {
  id?: string;
  brandKey?: string;
  target: string;
  scope: "domain" | "subdomains";
  capturedOn: string;
  capturedAt?: string;
  source: "scheduled" | "lookup";
  rank: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  referringPages: number | null;
  brokenBacklinks: number | null;
  brokenPages: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
  backlinksSpamScore: number | null;
  targetSpamScore: number | null;
};

export type BacklinksTabRows = {
  backlinks: BacklinksRow[];
  referringDomains: ReferringDomainRow[];
  topPages: TopPageRow[];
};

export type DomainRatings = Record<string, number | null>;

export type CsvValue = string | number | boolean | null | undefined;

export function buildBacklinksTabExport(args: {
  tab: BacklinksTab;
  rows: BacklinksTabRows;
  domainRatings?: DomainRatings | null;
}): { headers: string[]; rows: CsvValue[][] } {
  const { tab, rows, domainRatings } = args;
  const ratingFor = (domain: string | null | undefined): CsvValue => {
    if (!domainRatings || !domain) return null;
    return domainRatings[domain.replace(/^www\./, "")] ?? null;
  };

  if (tab === "backlinks") {
    return {
      headers: [
        "Domain",
        "Source URL",
        "Target URL",
        "Anchor",
        "Type",
        "Dofollow",
        "Rel Attributes",
        "Domain Rank",
        ...(domainRatings ? ["Ahrefs DR"] : []),
        "Source Page Rank",
        "Target Rank",
        "Spam Score",
        "First Seen",
        "Last Seen",
        "Lost",
        "Broken",
        "Links Count",
      ],
      rows: rows.backlinks.map((row) => [
        row.domainFrom,
        row.urlFrom,
        row.urlTo,
        row.anchor,
        row.itemType,
        row.isDofollow,
        row.relAttributes.join(", "),
        row.domainFromRank,
        ...(domainRatings ? [ratingFor(row.domainFrom)] : []),
        row.pageFromRank,
        row.rank,
        row.spamScore,
        row.firstSeen,
        row.lastSeen,
        row.isLost,
        row.isBroken,
        row.linksCount,
      ]),
    };
  }

  if (tab === "domains") {
    return {
      headers: [
        "Domain",
        "Backlinks",
        "Referring Pages",
        "Rank",
        ...(domainRatings ? ["Ahrefs DR"] : []),
        "Spam Score",
        "First Seen",
        "Broken Backlinks",
        "Broken Pages",
      ],
      rows: rows.referringDomains.map((row) => [
        row.domain,
        row.backlinks,
        row.referringPages,
        row.rank,
        ...(domainRatings ? [ratingFor(row.domain)] : []),
        row.spamScore,
        row.firstSeen,
        row.brokenBacklinks,
        row.brokenPages,
      ]),
    };
  }

  return {
    headers: [
      "Page",
      "Backlinks",
      "Referring Domains",
      "Rank",
      "Broken Backlinks",
    ],
    rows: rows.topPages.map((row) => [
      row.page,
      row.backlinks,
      row.referringDomains,
      row.rank,
      row.brokenBacklinks,
    ]),
  };
}

export function buildBacklinksTabFilename(
  tab: BacklinksTab,
  target: string,
): string {
  const tabPrefix =
    tab === "backlinks"
      ? "backlinks"
      : tab === "domains"
        ? "referring-domains"
        : "top-pages";
  const normalizedTarget = target
    .toLowerCase()
    .trim()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `backlinks-${tabPrefix}${normalizedTarget ? `-${normalizedTarget}` : ""}`;
}
