// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/domain/services/domainPagesPage.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  assertFilterConditionBudget,
  collectNumericRange,
  escapeLikeTerm,
  joinClauses,
  parseFilterTerms,
  type FilterClause,
} from "../providers/dataforseo/filters.ts";
import type { ScopeFilter } from "../providers/dataforseo/researchScopeFilters.ts";

export type DomainPagesSortMode = "traffic" | "keywords";
export type DomainPagesSortOrder = "asc" | "desc";

export type DomainPagesFilters = {
  include?: string;
  exclude?: string;
  minTraffic?: number;
  maxTraffic?: number;
  minVol?: number;
  maxVol?: number;
};

const SORT_FIELD_BY_MODE: Record<DomainPagesSortMode, string> = {
  traffic: "metrics.organic.etv",
  keywords: "metrics.organic.count",
};

export function buildPagesOrderBy(
  sortMode: DomainPagesSortMode,
  sortOrder: DomainPagesSortOrder = "desc",
): string[] {
  return [`${SORT_FIELD_BY_MODE[sortMode]},${sortOrder}`];
}

export function buildPageFilters(
  filters: DomainPagesFilters,
  searchTerm?: string,
  scopeFilter?: ScopeFilter,
): unknown[] {
  const conditions: FilterClause[] = [];

  for (const term of parseFilterTerms(filters.include)) {
    conditions.push(["page_address", "ilike", `%${escapeLikeTerm(term)}%`]);
  }
  for (const term of parseFilterTerms(filters.exclude)) {
    conditions.push(["page_address", "not_ilike", `%${escapeLikeTerm(term)}%`]);
  }

  collectNumericRange(
    conditions,
    "metrics.organic.etv",
    filters.minTraffic,
    filters.maxTraffic,
  );
  collectNumericRange(
    conditions,
    "metrics.organic.count",
    filters.minVol,
    filters.maxVol,
  );

  const trimmed = searchTerm?.trim();
  if (trimmed) {
    conditions.push(["page_address", "ilike", `%${escapeLikeTerm(trimmed)}%`]);
  }

  assertFilterConditionBudget(
    (scopeFilter?.conditionCount ?? 0) + conditions.length,
  );

  return joinClauses(
    [
      ...(scopeFilter?.clauses ?? []),
      ...conditions,
    ],
    "and",
  );
}
