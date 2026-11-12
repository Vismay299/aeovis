"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/search-tabs/useSearchTabs.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useSearchTabs } from "@/components/app/search-tabs/useSearchTabs";
import { LOCATIONS } from "@/shared/keyword-locations";
import type { DomainSortMode, DomainTab, SortOrder } from "@/shared/domain";
import type { ResearchScope } from "@/shared/researchScope";

export type DomainTabInput = {
  domain: string;
  scope?: ResearchScope;
  sort?: DomainSortMode;
  order?: SortOrder;
  tab?: DomainTab;
  loc?: number;
};

export function parseDomainTabInput(raw: unknown): DomainTabInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.domain !== "string" || candidate.domain.trim() === "") {
    return null;
  }
  return {
    domain: candidate.domain.trim(),
    scope: candidate.scope as ResearchScope | undefined,
    sort: candidate.sort as DomainSortMode | undefined,
    order: candidate.order as SortOrder | undefined,
    tab: candidate.tab as DomainTab | undefined,
    loc: typeof candidate.loc === "number" ? candidate.loc : undefined,
  };
}

export function formatDomainTabLabel(
  input: DomainTabInput,
  defaultLocationCode = 2840,
): string {
  if (input.loc && input.loc !== defaultLocationCode) {
    const suffix = LOCATIONS[input.loc] ?? String(input.loc);
    return `${input.domain} (${suffix})`;
  }
  return input.domain;
}

export function useDomainSearchTabs(brandKey: string) {
  return useSearchTabs<DomainTabInput>("domain", brandKey, parseDomainTabInput);
}
