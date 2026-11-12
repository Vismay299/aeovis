// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/useBacklinksDomainExpansion.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { keys, stableStringify } from "@/lib/query/keys";
import { fetchJson } from "@/lib/query/fetchJson";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { paidQueryOptions } from "./useBacklinksPageData";
import type { BacklinksRow, BacklinksTargetScope } from "@/shared/backlinks";

const DOMAIN_LINKS_PAGE_SIZE = 100;
const DOMAIN_LINKS_STALE_TIME_MS = 5 * 60 * 1000;

export type BacklinksDomainEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; rows: BacklinksRow[] };

export type BacklinksDomainExpansion = {
  expandedDomains: ReadonlySet<string>;
  /** One entry per expanded domain; keyed by the row's raw domainFrom. */
  entriesByDomain: Record<string, BacklinksDomainEntry>;
  toggleDomain: (domain: string) => void;
};

type UseBacklinksDomainExpansionArgs = {
  brandKey: string;
  target?: string;
  scope?: BacklinksTargetScope;
  tab?: string;
  view?: string;
  includeSpam?: boolean;
  rows: BacklinksRow[];
  isLive?: boolean;
};

type BacklinksRowsApiResponse = {
  status: string;
  rows: BacklinksRow[];
  totalCount: number;
  hasMore: boolean;
};

export function useBacklinksDomainExpansion({
  brandKey,
  target,
  scope,
  tab,
  view,
  includeSpam,
  rows,
  isLive = true,
}: UseBacklinksDomainExpansionArgs): BacklinksDomainExpansion {
  const [expanded, setExpanded] = useState<string[]>([]);

  // Collapse everything when the lookup changes.
  useEffect(() => {
    setExpanded([]);
  }, [brandKey, target, scope]);

  // Expansions are priced as backlinks.expand_domain; live ones carry that
  // quote as their ceiling and wait for it.
  const expandQuote = usePriceQuote(
    { brandKey, action: "backlinks.expand_domain", input: {} },
    { enabled: isLive && expanded.length > 0 && Boolean(target) },
  );
  const expandMaxUsd = expandQuote.isPlaceholderData ? undefined : expandQuote.data?.totalUsd;

  const queries = useQueries({
    queries: expanded.map((domain) => {
      const input = {
        target: target ?? "",
        scope,
        domain,
        hideSpam: !includeSpam,
        cacheOnly: !isLive,
      };
      const inputKey = stableStringify(input);

      return {
        enabled:
          Boolean(target) &&
          tab === "backlinks" &&
          view !== "all" &&
          rows.some((row) => row.domainFrom === domain) &&
          (!isLive || expandMaxUsd !== undefined),
        ...paidQueryOptions(isLive),
        queryKey: keys.backlinksDomainLinks(brandKey, inputKey),
        staleTime: DOMAIN_LINKS_STALE_TIME_MS,
        queryFn: () =>
          fetchJson<BacklinksRowsApiResponse>(
            "/api/customer/backlinks/rows",
            {
              method: "POST",
              body: {
                target,
                scope,
                page: 1,
                pageSize: DOMAIN_LINKS_PAGE_SIZE,
                sortField: "rank",
                sortOrder: "desc",
                filters: { domainFrom: domain },
                mode: "as_is",
                hideSpam: !includeSpam,
                cacheOnly: !isLive,
                ...(isLive && expandMaxUsd !== undefined ? { maxUsd: expandMaxUsd } : {}),
                requestId: crypto.randomUUID(),
              },
            },
          ),
      };
    }),
  });

  const entriesByDomain = useMemo(() => {
    const map: Record<string, BacklinksDomainEntry> = {};
    expanded.forEach((domain, index) => {
      const query = queries[index];
      if (!query) return;
      map[domain] = query.data
        ? { status: "ready", rows: query.data.rows }
        : query.error
          ? { status: "error" }
          : { status: "loading" };
    });
    return map;
  }, [expanded, queries]);

  const expandedDomains = useMemo(() => new Set(expanded), [expanded]);

  const toggleDomain = useCallback((domain: string) => {
    setExpanded((current) =>
      current.includes(domain)
        ? current.filter((entry) => entry !== domain)
        : [...current, domain],
    );
  }, []);

  return { expandedDomains, entriesByDomain, toggleDomain };
}
