"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/KeywordsTab.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExportMenu } from "@/components/app/ExportMenu";
import { QueryError } from "@/components/app/QueryState";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useExportRows } from "@/components/app/export/useExportRows";
import type { ExportFormat } from "@/lib/export/exportRows";
import {
  competitorsToTable,
  type DomainOverviewRouteState,
} from "@/shared/domain";
import type { ResearchScope } from "@/shared/researchScope";
import { DomainCompetitorsTable } from "./DomainCompetitorsTable";
import {
  DomainPriceChangeReview,
  domainPriceChangeFromError,
} from "./DomainPriceChangeReview";
import {
  useDomainCompetitorsQuery,
  type CompetitorSortBy,
} from "./hooks/useDomainCompetitors";
import {
  useDomainKeywordsQuery,
  type DomainKeywordItem,
} from "./hooks/useDomainKeywordsQuery";
import { trackDomainEvent } from "./telemetry";

type Props = {
  brandKey: string;
  /** The overview's display target, for the idle sentence. */
  displayTarget: string;
  /** The overview's hostname, sent to the competitors route. */
  domain: string;
  scope: ResearchScope;
  /** The shown market's language, sent with the request and the quote. */
  languageCode: string;
  routeState: DomainOverviewRouteState;
  tabs: ReactNode;
  hasProjectMemory: boolean;
  onCompetitorAdded?: (domain: string) => void;
};

/** The competitors route accepts at most 100 keywords per request. */
const MAX_COMPETITOR_KEYWORDS = 100;
const COMPETITOR_LIMIT = 50;
const NO_KEYWORDS: DomainKeywordItem[] = [];

const SORT_ITEMS: Array<{ value: CompetitorSortBy; label: string }> = [
  { value: "visibility", label: "Visibility" },
  { value: "traffic_estimate", label: "Estimated traffic" },
  { value: "avg_position", label: "Average position" },
  { value: "keyword_count", label: "Keyword count" },
];

export function CompetitorsTab({
  brandKey,
  displayTarget,
  domain,
  scope,
  languageCode,
  routeState,
  tabs,
  hasProjectMemory,
  onCompetitorAdded,
}: Props) {
  const [sortBy, setSortBy] = useState<CompetitorSortBy>("visibility");
  // The approved quote for one paid request. A sort change clears it, so the
  // next read is a free cache peek and never a second provider call.
  const [approval, setApproval] = useState<{
    context: string;
    maxUsd: number;
  } | null>(null);
  const runExport = useExportRows();
  const lastTracked = useRef<string | null>(null);
  const queryClient = useQueryClient();

  // The idle copy counts the rows on the current Top Keywords page, so this
  // tab reads the same page. It is always a cache peek: no gesture, no spend.
  const keywordsQuery = useDomainKeywordsQuery({
    brandKey,
    domain: routeState.domain,
    scope: routeState.scope,
    locationCode: routeState.locationCode,
    page: routeState.page,
    pageSize: routeState.pageSize,
    sortMode: routeState.sort,
    sortOrder: routeState.order,
    appliedFilters: routeState.appliedFilters,
    cacheOnly: true,
    enabled: Boolean(routeState.domain),
  });

  const keywordRows =
    keywordsQuery.data?.status === "ok"
      ? keywordsQuery.data.keywords
      : NO_KEYWORDS;
  const requestKeywords = useMemo(
    () =>
      keywordRows
        .slice(0, MAX_COMPETITOR_KEYWORDS)
        .map((row) => row.keyword),
    [keywordRows],
  );
  // The idle copy names the keywords this tab actually sends (at most 100),
  // so the sentence matches the price input and the request body.
  const sentKeywordCount = requestKeywords.length;
  const priceKeywordCount = Math.max(sentKeywordCount, 1);

  // FE-1: the approval is bound to the exact request, not just the market. A
  // different keyword set, sort, limit or language drops it and falls back to a
  // free cache-only read, so an unapproved request can never spend.
  const approvalContext = JSON.stringify({
    brandKey,
    domain,
    scope,
    locationCode: routeState.locationCode,
    languageCode,
    keywords: requestKeywords,
    sortBy,
    limit: COMPETITOR_LIMIT,
  });
  const liveMaxUsd =
    approval?.context === approvalContext ? approval.maxUsd : undefined;

  const competitorsQuery = useDomainCompetitorsQuery({
    brandKey,
    domain,
    scope,
    locationCode: routeState.locationCode,
    languageCode,
    keywords: requestKeywords,
    sortBy,
    limit: COMPETITOR_LIMIT,
    cacheOnly: liveMaxUsd == null,
    maxUsd: liveMaxUsd,
    enabled: sentKeywordCount > 0,
  });

  const response = competitorsQuery.data;
  const isOk = response?.status === "ok";
  const rows = useMemo(
    () => (response?.status === "ok" ? response.competitors : []),
    [response],
  );
  const priceChanged = domainPriceChangeFromError(competitorsQuery.error);

  const fetchedAt = response?.status === "ok" ? response.fetchedAt : undefined;

  // FE-2: a paid run fills the provider cache, so every sibling cache-only read
  // (a remount, a sort round-trip) must revalidate instead of replaying a stale
  // pre-run "not_cached". Marking the entries stale issues no request now; the
  // next cache-only read is free.
  const liveSucceededAt = isOk && liveMaxUsd != null ? (fetchedAt ?? "ok") : null;
  useEffect(() => {
    if (liveSucceededAt == null) return;
    void queryClient.invalidateQueries({
      queryKey: ["domainCompetitors", brandKey],
      refetchType: "none",
    });
  }, [brandKey, liveSucceededAt, queryClient]);

  // One event per paid result set.
  useEffect(() => {
    if (liveMaxUsd == null || !isOk) return;
    const identity = `${sortBy}:${fetchedAt ?? ""}`;
    if (lastTracked.current === identity) return;
    lastTracked.current = identity;
    trackDomainEvent("domain_overview:competitors", {
      keyword_count: sentKeywordCount,
      result_count: rows.length,
    });
  }, [fetchedAt, isOk, liveMaxUsd, rows.length, sentKeywordCount, sortBy]);

  const handleRun = useCallback(
    (maxUsd: number) => {
      setApproval({ context: approvalContext, maxUsd });
    },
    [approvalContext],
  );

  const handleSortChange = useCallback((nextSort: CompetitorSortBy) => {
    setSortBy(nextSort);
    // Never re-spend on a sort change: the provider cache key ignores sortBy,
    // so a cache-only read returns the correctly sorted slice for free.
    setApproval(null);
  }, []);

  const handleExport = useCallback(
    (format: ExportFormat) => {
      const table = competitorsToTable(
        rows.map((row) => ({
          domain: row.domain,
          // The shared helper types these as numbers; a null metric is
          // written as an empty CSV cell.
          keywordsCount: row.keywordsCount as number,
          avgPosition: row.avgPosition as number,
          visibility: row.visibility as number,
          etv: row.etv as number,
        })),
      );
      void runExport({
        format,
        feature: "domain_overview",
        headers: table.headers,
        rows: table.rows,
        filename: `${domain || "domain"}-competitors`,
      });
    },
    [domain, rows, runExport],
  );

  const queryError = competitorsQuery.isError
    ? priceChanged ? (
        <DomainPriceChangeReview
          label="Review new price"
          pendingLabel="Finding competitors..."
          brandKey={brandKey}
          action="domain.competitors.run"
          input={{
            domain,
            scope,
            locationCode: routeState.locationCode,
            languageCode,
            keywordCount: priceKeywordCount,
            limit: COMPETITOR_LIMIT,
          }}
          pending={competitorsQuery.isFetching}
          onRun={handleRun}
          dialogTitle="Review competitor price"
          confirmLabel="Find competitors"
          priceChanged={priceChanged}
        />
      ) : (
        <QueryError
          error={competitorsQuery.error}
          fallback="Lookup failed."
          onRetry={() => void competitorsQuery.refetch()}
          isRetrying={competitorsQuery.isFetching}
        />
      )
    : null;

  const idle = (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-base font-medium">
          Find the domains that rank in Google for the same keywords as{" "}
          {displayTarget}.
        </p>
        <p className="text-sm text-muted-foreground">
          Uses the {sentKeywordCount} keywords on the current Top Keywords page.
        </p>
      </div>
      <div
        title={
          sentKeywordCount === 0 ? "Load the Top Keywords tab first." : undefined
        }
      >
        <PricedActionButton
          label="Find competitors"
          pendingLabel="Finding competitors..."
          brandKey={brandKey}
          action="domain.competitors.run"
          input={{
            domain,
            scope,
            locationCode: routeState.locationCode,
            languageCode,
            keywordCount: priceKeywordCount,
            limit: COMPETITOR_LIMIT,
          }}
          enabled={sentKeywordCount > 0}
          pending={liveMaxUsd != null && competitorsQuery.isFetching}
          onRun={handleRun}
          alwaysConfirm
          dialogTitle="Find SERP competitors"
          confirmLabel="Find competitors"
        />
      </div>
    </div>
  );

  const results = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          items={SORT_ITEMS}
          value={sortBy}
          onValueChange={(value) => {
            const next = SORT_ITEMS.find((item) => item.value === value);
            if (next) handleSortChange(next.value);
          }}
        >
          <SelectTrigger aria-label="Sort competitors" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <ExportMenu
          actions={["sheets", "csv"]}
          onExport={(action) => handleExport(action as ExportFormat)}
        />
      </div>

      <DomainCompetitorsTable
        brandKey={brandKey}
        rows={rows}
        keywordCount={response?.keywordCount ?? sentKeywordCount}
        hasProjectMemory={hasProjectMemory}
        onCompetitorAdded={onCompetitorAdded}
      />
    </div>
  );

  return (
    <div className="rounded-xl border border-border bg-card">
      {tabs}
      <div className="space-y-4 px-4 py-4">
        {isOk ? results : competitorsQuery.isError ? null : idle}
        {queryError}
      </div>
    </div>
  );
}
