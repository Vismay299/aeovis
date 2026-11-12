"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/hooks/useDomainSearchHistory.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { useTimestampedSearchHistory } from "@/components/app/hooks/useTimestampedSearchHistory";
import {
  DOMAIN_SORT_MODES,
  DOMAIN_TABS,
  type DomainSortMode,
  type DomainTab,
} from "@/shared/domain";
import {
  researchScopeSchema,
  type ResearchScope,
} from "@/shared/researchScope";

export type DomainSearchHistoryBody = {
  domain: string;
  scope?: ResearchScope;
  sort?: DomainSortMode;
  tab?: DomainTab;
  locationCode?: number;
};

export type DomainSearchHistoryItem = DomainSearchHistoryBody & {
  timestamp: number;
};

const domainSearchHistoryBodySchema = z.object({
  domain: z.string(),
  scope: researchScopeSchema.optional().default("subdomains"),
  sort: z.enum(DOMAIN_SORT_MODES).optional().default("traffic"),
  tab: z.enum(DOMAIN_TABS).optional().default("keywords"),
  locationCode: z.number().int().positive().optional(),
});

export function useDomainSearchHistory(brandKey: string) {
  return useTimestampedSearchHistory<DomainSearchHistoryBody>({
    storageKey: `domain-search-history:${brandKey}`,
    bodySchema: domainSearchHistoryBodySchema,
    isSame: (a, b) =>
      a.domain.toLowerCase() === b.domain.toLowerCase() &&
      (a.scope ?? "subdomains") === (b.scope ?? "subdomains") &&
      a.locationCode === b.locationCode,
  });
}
