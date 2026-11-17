// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/backlinks.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../../http/appError.ts";
import {
  assertOk,
  buildTaskBilling,
  parseTaskItems,
  parseTaskTotalCount,
  type DataforseoApiResponse,
} from "./envelope.ts";
import { dataforseoPost, type DataforseoRequestOptions } from "./core.ts";
import { createDataforseoBillingClassifier } from "./billingClassification.ts";
import { meter } from "./client.ts";
import {
  BACKLINKS_DEFAULT_LIMIT,
  dataforseoPricing,
} from "../../pricing/dataforseo.ts";
import type { SpendFeature } from "../../spend-features.ts";

export { BACKLINKS_DEFAULT_LIMIT };
export const DEFAULT_BACKLINKS_SPAM_THRESHOLD = 40;

/**
 * Default spend feature for the F16 research entries.
 * F16 P2.T1.S1 adds "backlinks.research" to SPEND_FEATURES; until then it is not
 * in the closed union, so it is cast here.
 */
export const BACKLINKS_RESEARCH_FEATURE =
  "backlinks.research" as unknown as SpendFeature;

export type BacklinksRequest = {
  target: string;
  /**
   * Whether the target's subdomains count. Defaults to DataForSEO's `true`.
   * The API ignores it for page targets; `backlinks/history/live` has no such
   * field, so a domain-scoped history is always subdomain-inclusive.
   */
  includeSubdomains?: boolean;
};

export type BacklinksSpamFilterOptions = {
  hideSpam?: boolean;
};

export type BacklinksListRequest = BacklinksRequest &
  BacklinksSpamFilterOptions & {
    limit?: number;
    offset?: number;
    /** DataForSEO order_by entries, e.g. ["rank,desc"]. */
    orderBy?: string[];
    /** Pre-built DataForSEO filter expressions, already joined with and/or. */
    filters?: unknown[];
    /** Result grouping (backlinks list only): "one_per_domain" | "as_is". */
    mode?: string;
    status?: "live" | "lost" | "all";
  };

export type BacklinksTimeseriesRequest = {
  target: string;
  dateFrom: string;
  dateTo: string;
};

const classifyBacklinksError = createDataforseoBillingClassifier({
  pathPrefix: "/backlinks/",
  billingIssueCode: "dataforseo_balance",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue.",
});

// DataForSEO ships both the misspelled (`*_reffering_*`) and corrected keys; we
// accept both via passthrough so callers can read whichever is present.
export const backlinksSummaryItemSchema = z.looseObject({
  target: z.string().optional(),
  rank: z.number().nullable().optional(),
  backlinks: z.number().nullable().optional(),
  referring_pages: z.number().nullable().optional(),
  referring_domains: z.number().nullable().optional(),
  broken_backlinks: z.number().nullable().optional(),
  broken_pages: z.number().nullable().optional(),
  new_backlinks: z.number().nullable().optional(),
  lost_backlinks: z.number().nullable().optional(),
  new_reffering_domains: z.number().nullable().optional(),
  lost_reffering_domains: z.number().nullable().optional(),
  new_referring_domains: z.number().nullable().optional(),
  lost_referring_domains: z.number().nullable().optional(),
  backlinks_spam_score: z.number().nullable().optional(),
  info: z
    .looseObject({ target_spam_score: z.number().nullable().optional() })
    .nullable()
    .optional(),
});

export const backlinksItemSchema = z.looseObject({
  domain_from: z.string().nullable().optional(),
  url_from: z.string().nullable().optional(),
  url_to: z.string().nullable().optional(),
  anchor: z.string().nullable().optional(),
  item_type: z.string().nullable().optional(),
  dofollow: z.boolean().nullable().optional(),
  rank: z.number().nullable().optional(),
  domain_from_rank: z.number().nullable().optional(),
  page_from_rank: z.number().nullable().optional(),
  backlinks_spam_score: z.number().nullable().optional(),
  backlink_spam_score: z.number().nullable().optional(),
  first_seen: z.string().nullable().optional(),
  last_seen: z.string().nullable().optional(),
  last_visited: z.string().nullable().optional(),
  lost_date: z.string().nullable().optional(),
  is_new: z.boolean().nullable().optional(),
  is_lost: z.boolean().nullable().optional(),
  is_broken: z.boolean().nullable().optional(),
  links_count: z.number().nullable().optional(),
  rel_attributes: z.array(z.string()).nullable().optional(),
  attributes: z.array(z.string()).nullable().optional(),
});

export const referringDomainItemSchema = z.looseObject({
  domain: z.string().nullable().optional(),
  backlinks: z.number().nullable().optional(),
  referring_pages: z.number().nullable().optional(),
  rank: z.number().nullable().optional(),
  first_seen: z.string().nullable().optional(),
  broken_backlinks: z.number().nullable().optional(),
  broken_pages: z.number().nullable().optional(),
  backlinks_spam_score: z.number().nullable().optional(),
  target_spam_score: z.number().nullable().optional(),
});

export const domainPageSummaryItemSchema = z.looseObject({
  page: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  backlinks: z.number().nullable().optional(),
  referring_domains: z.number().nullable().optional(),
  rank: z.number().nullable().optional(),
  broken_backlinks: z.number().nullable().optional(),
});

export const backlinksHistoryItemSchema = z.looseObject({
  date: z.string().nullable().optional(),
  rank: z.number().nullable().optional(),
  backlinks: z.number().nullable().optional(),
  referring_domains: z.number().nullable().optional(),
  new_backlinks: z.number().nullable().optional(),
  lost_backlinks: z.number().nullable().optional(),
  new_reffering_domains: z.number().nullable().optional(),
  lost_reffering_domains: z.number().nullable().optional(),
  new_referring_domains: z.number().nullable().optional(),
  lost_referring_domains: z.number().nullable().optional(),
});

function buildCommonPayload(input: BacklinksRequest) {
  return {
    target: input.target,
    include_subdomains: input.includeSubdomains ?? true,
    include_indirect_links: true,
    exclude_internal_backlinks: true,
    backlinks_status_type: "live",
    rank_scale: "one_hundred",
  };
}

const assertOptions = (path: string) =>
  ({ classify: classifyBacklinksError, classifyPath: path }) as const;

/**
 * Joins caller-provided filter expressions with the spam-score condition.
 * `userFilters` arrives already and/or-joined, so the spam condition is
 * appended with a single top-level "and".
 */
function combineFilters(
  userFilters: unknown[] | undefined,
  spamCondition: unknown[] | undefined,
): unknown[] | undefined {
  const merged: unknown[] = [];
  if (userFilters && userFilters.length > 0) merged.push(...userFilters);
  if (spamCondition) {
    if (merged.length > 0) merged.push("and");
    merged.push(spamCondition);
  }
  return merged.length > 0 ? merged : undefined;
}

export async function fetchBacklinksSummary(
  input: BacklinksRequest,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<BacklinksSummaryItem>> {
  const response = await dataforseoPost(
    "/v3/backlinks/summary/live",
    [buildCommonPayload(input)],
    { classify: classifyBacklinksError, ...options },
  );
  const task = assertOk(response, assertOptions("/v3/backlinks/summary/live"));

  const firstResult = task.result?.[0];
  if (firstResult) {
    const parsed = backlinksSummaryItemSchema.safeParse(firstResult);
    if (!parsed.success) {
      console.error(
        "dataforseo.backlinks-summary-live.invalid-result",
        parsed.error.issues.slice(0, 5),
      );
      throw new AppError(
        502,
        "dataforseo_bad_response",
        "DataForSEO backlinks-summary-live returned an invalid response shape",
      );
    }
    return {
      data: parsed.data,
      billing: buildTaskBilling(task),
    };
  }

  return {
    data: {} as BacklinksSummaryItem,
    billing: buildTaskBilling(task),
  };
}

export async function fetchBacklinksRows(
  input: BacklinksListRequest,
  options?: DataforseoRequestOptions,
): Promise<
  DataforseoApiResponse<{
    items: BacklinksItem[];
    totalCount: number | null;
  }>
> {
  const filters = combineFilters(
    input.filters,
    (input.hideSpam ?? true)
      ? [
          ["backlink_spam_score", "<", DEFAULT_BACKLINKS_SPAM_THRESHOLD],
          "or",
          ["backlink_spam_score", "=", null],
        ]
      : undefined,
  );
  const response = await dataforseoPost(
    "/v3/backlinks/backlinks/live",
    [
      {
        ...buildCommonPayload(input),
        backlinks_status_type: input.status ?? "live",
        limit: input.limit ?? BACKLINKS_DEFAULT_LIMIT,
        offset: input.offset,
        order_by: input.orderBy ?? ["rank,desc"],
        mode: input.mode,
        ...(filters ? { filters } : {}),
      },
    ],
    { classify: classifyBacklinksError, ...options },
  );
  const task = assertOk(
    response,
    assertOptions("/v3/backlinks/backlinks/live"),
  );
  return {
    data: {
      items: parseTaskItems("backlinks-live", task, backlinksItemSchema),
      totalCount: parseTaskTotalCount(task),
    },
    billing: buildTaskBilling(task),
  };
}

export async function fetchReferringDomains(
  input: BacklinksListRequest,
  options?: DataforseoRequestOptions,
): Promise<
  DataforseoApiResponse<{
    items: ReferringDomainItem[];
    totalCount: number | null;
  }>
> {
  const filters = combineFilters(
    input.filters,
    (input.hideSpam ?? true)
      ? ["backlinks_spam_score", "<=", DEFAULT_BACKLINKS_SPAM_THRESHOLD]
      : undefined,
  );
  const response = await dataforseoPost(
    "/v3/backlinks/referring_domains/live",
    [
      {
        ...buildCommonPayload(input),
        limit: input.limit ?? BACKLINKS_DEFAULT_LIMIT,
        offset: input.offset,
        order_by: input.orderBy ?? ["backlinks,desc"],
        ...(filters ? { filters } : {}),
      },
    ],
    { classify: classifyBacklinksError, ...options },
  );
  const task = assertOk(
    response,
    assertOptions("/v3/backlinks/referring_domains/live"),
  );
  return {
    data: {
      items: parseTaskItems(
        "referring-domains-live",
        task,
        referringDomainItemSchema,
      ),
      totalCount: parseTaskTotalCount(task),
    },
    billing: buildTaskBilling(task),
  };
}

export async function fetchDomainPagesSummary(
  input: BacklinksListRequest,
  options?: DataforseoRequestOptions,
): Promise<
  DataforseoApiResponse<{
    items: DomainPageSummaryItem[];
    totalCount: number | null;
  }>
> {
  const filters =
    input.filters && input.filters.length > 0 ? input.filters : undefined;
  const response = await dataforseoPost(
    "/v3/backlinks/domain_pages_summary/live",
    [
      {
        ...buildCommonPayload(input),
        limit: input.limit ?? BACKLINKS_DEFAULT_LIMIT,
        offset: input.offset,
        order_by: input.orderBy ?? ["backlinks,desc"],
        ...(filters ? { filters } : {}),
      },
    ],
    { classify: classifyBacklinksError, ...options },
  );
  const task = assertOk(
    response,
    assertOptions("/v3/backlinks/domain_pages_summary/live"),
  );
  return {
    data: {
      items: parseTaskItems(
        "domain-pages-summary-live",
        task,
        domainPageSummaryItemSchema,
      ),
      totalCount: parseTaskTotalCount(task),
    },
    billing: buildTaskBilling(task),
  };
}

export async function fetchBacklinksHistory(
  input: BacklinksTimeseriesRequest,
  options?: DataforseoRequestOptions,
): Promise<DataforseoApiResponse<BacklinksHistoryItem[]>> {
  const response = await dataforseoPost(
    "/v3/backlinks/history/live",
    [
      {
        target: input.target,
        date_from: input.dateFrom,
        date_to: input.dateTo,
        rank_scale: "one_hundred",
      },
    ],
    { classify: classifyBacklinksError, ...options },
  );
  const task = assertOk(response, assertOptions("/v3/backlinks/history/live"));
  return {
    data: parseTaskItems(
      "backlinks-history-live",
      task,
      backlinksHistoryItemSchema,
    ),
    billing: buildTaskBilling(task),
  };
}

export function createBacklinksClient(deps?: { meter?: typeof meter }) {
  const m = deps?.meter ?? meter;
  return {
    summary: m(
      fetchBacklinksSummary,
      () => dataforseoPricing.backlinks.summary({}),
      BACKLINKS_RESEARCH_FEATURE,
    ),
    rows: m(
      fetchBacklinksRows,
      (i) =>
        dataforseoPricing.backlinks.rows({
          limit: i.limit ?? BACKLINKS_DEFAULT_LIMIT,
        }),
      BACKLINKS_RESEARCH_FEATURE,
    ),
    referringDomains: m(
      fetchReferringDomains,
      (i) =>
        dataforseoPricing.backlinks.referringDomains({
          limit: i.limit ?? BACKLINKS_DEFAULT_LIMIT,
        }),
      BACKLINKS_RESEARCH_FEATURE,
    ),
    domainPages: m(
      fetchDomainPagesSummary,
      (i) =>
        dataforseoPricing.backlinks.domainPages({
          limit: i.limit ?? BACKLINKS_DEFAULT_LIMIT,
        }),
      BACKLINKS_RESEARCH_FEATURE,
    ),
    history: m(
      fetchBacklinksHistory,
      (i) =>
        dataforseoPricing.backlinks.history({
          dateFrom: i.dateFrom,
          dateTo: i.dateTo,
        }),
      BACKLINKS_RESEARCH_FEATURE,
    ),
  };
}

export type BacklinksClient = ReturnType<typeof createBacklinksClient>;

export type BacklinksSummaryItem = z.infer<typeof backlinksSummaryItemSchema>;
export type BacklinksItem = z.infer<typeof backlinksItemSchema>;
export type ReferringDomainItem = z.infer<typeof referringDomainItemSchema>;
export type DomainPageSummaryItem = z.infer<typeof domainPageSummaryItemSchema>;
export type BacklinksHistoryItem = z.infer<typeof backlinksHistoryItemSchema>;
