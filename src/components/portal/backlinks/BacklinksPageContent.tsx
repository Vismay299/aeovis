"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksPageContent.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { resolveBacklinksScope } from "./hooks/useBacklinksPageData";
import { useMemo, type ReactNode } from "react";
import { Link2 } from "lucide-react";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import {
  BacklinksOverviewPanels,
  BacklinksScopeAlert,
} from "./BacklinksOverviewPanels";
import { BacklinksResultsCard } from "./BacklinksPageSections";
import { BacklinksLoadingState } from "./BacklinksPageStates";
import { BacklinksNotLoadedCard } from "./BacklinksNotLoadedCard";
import type { BacklinksSearchHistoryItem } from "./hooks/useBacklinksSearchHistory";
import {
  RESEARCH_SCOPE_LABELS,
  type ResearchScope,
} from "@/shared/researchScope";
import {
  buildSummaryStats,
  type BacklinksRow,
  type BacklinksTab,
  type ReferringDomainRow,
  type TopPageRow,
} from "@/shared/backlinks";
import type { BacklinksDomainExpansion } from "./hooks/useBacklinksDomainExpansion";
import type { BacklinksFiltersState } from "./hooks/useBacklinksFilters";
import type {
  BacklinksPageData,
  BacklinksSearchState,
} from "./hooks/useBacklinksPageData";
import { QueryError } from "@/components/app/QueryState";
import { Card } from "@/components/ui/card";
import { RecentSearches } from "@/components/app/RecentSearches";

export function BacklinksBody({
  brandKey,
  history,
  historyLoaded,
  data,
  searchState,
  filters,
  sorting,
  domainExpansion,
  tabControls,
  onRunLookup,
  onPageChange,
  onPageSizeChange,
  onRemoveHistoryItem,
  onSelectHistoryItem,
  onSortingChange,
  onTabChange,
  onViewChange,
  onHideSpamChange,
}: {
  brandKey: string;
  history: BacklinksSearchHistoryItem[];
  historyLoaded: boolean;
  data: BacklinksPageData;
  searchState: BacklinksSearchState;
  filters: BacklinksFiltersState;
  sorting: SortingState;
  domainExpansion: BacklinksDomainExpansion;
  tabControls?: ReactNode;
  onRunLookup: (maxUsd: number) => void;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextPageSize: number) => void;
  onRemoveHistoryItem: (timestamp: number) => void;
  onSelectHistoryItem: (item: BacklinksSearchHistoryItem) => void;
  onSortingChange: OnChangeFn<SortingState>;
  onTabChange: (tab: BacklinksTab) => void;
  onViewChange: (view: "all" | undefined) => void;
  onHideSpamChange: (hideSpam: boolean) => void;
}) {
  const overviewData = data.overviewData;
  const backlinksRowsPage = data.rowsQuery.data;
  const referringDomainsPage = data.referringDomainsQuery.data;
  const topPagesPage = data.topPagesQuery.data;

  const tabRows = useMemo<{
    backlinks: BacklinksRow[];
    referringDomains: ReferringDomainRow[];
    topPages: TopPageRow[];
  }>(
    () => ({
      backlinks: backlinksRowsPage?.rows ?? [],
      referringDomains: referringDomainsPage?.rows ?? [],
      topPages: topPagesPage?.rows ?? [],
    }),
    [backlinksRowsPage, referringDomainsPage, topPagesPage],
  );

  const activeTabPage = data.activeTabQuery.data;
  const summaryStats = useMemo(
    () => buildSummaryStats(overviewData ? { summary: overviewData.summary } : undefined),
    [overviewData],
  );

  if (!searchState.target) {
    return (
      <RecentSearches
        items={history}
        loaded={historyLoaded}
        onRemove={onRemoveHistoryItem}
        emptyIcon={Link2}
        emptyTitle="Enter a domain or URL to get started"
        getTitle={(item) => item.target}
        getSubtitle={(item) => RESEARCH_SCOPE_LABELS[item.scope]}
        renderLink={(item, props) => (
          <button
            type="button"
            onClick={() => onSelectHistoryItem(item)}
            {...props}
          />
        )}
      />
    );
  }

  if (data.overviewQuery.isPending && !data.overviewQuery.data) {
    return (
      <>
        {tabControls}
        <BacklinksLoadingState />
      </>
    );
  }

  if (data.isNotCached) {
    return (
      <>
        {tabControls}
        <BacklinksNotLoadedCard
          brandKey={brandKey}
          target={searchState.target}
          displayTarget={searchState.target}
          scope={resolveBacklinksScope(searchState.target, searchState.scope)}
          onRunLookup={onRunLookup}
          pending={data.overviewQuery.isFetching}
        />
      </>
    );
  }

  if (!overviewData) {
    return (
      <>
        {tabControls}
        <QueryError
          title="Could not load backlinks"
          cause={data.overviewQuery.error}
          fallback={
            data.overviewErrorMessage ?? "Please try again in a moment."
          }
          onRetry={() => void data.overviewQuery.refetch()}
          isRetrying={data.overviewQuery.isFetching}
        />
      </>
    );
  }

  return (
    <>
      {tabControls}
      <BacklinksScopeAlert scope={overviewData.scope} />
      <Card className="gap-0 py-0">
        <BacklinksOverviewPanels
          data={overviewData}
          summaryStats={summaryStats}
        />
        <div className="px-4 pb-4">
          <BacklinksResultsCard
            brandKey={brandKey}
            activeTab={searchState.tab ?? "backlinks"}
            scope={resolveBacklinksScope(searchState.target, searchState.scope)}
            tabRows={tabRows}
            filters={filters}
            sorting={sorting}
            view={searchState.view}
            hideSpam={!searchState.includeSpam}
            onHideSpamChange={onHideSpamChange}
            domainExpansion={domainExpansion}
            isTabLoading={
              data.activeTabQuery.isPending && !data.activeTabFilterError
            }
            showTable={
              activeTabPage !== undefined && !data.activeTabFilterError
            }
            tabErrorMessage={data.activeTabErrorMessage}
            tabError={
              data.activeTabFilterError ? undefined : data.activeTabQuery.error
            }
            onRetryTab={
              data.activeTabFilterError
                ? undefined
                : () => void data.activeTabQuery.refetch()
            }
            isTabRetrying={data.activeTabQuery.isFetching}
            exportTarget={overviewData.displayTarget || searchState.target}
            pagination={{
              page: searchState.page ?? 1,
              pageSize: searchState.size ?? 50,
              totalCount: activeTabPage?.totalCount ?? null,
              hasNextPage: activeTabPage?.hasMore ?? false,
              isFetching: data.activeTabQuery.isFetching,
            }}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            onSortingChange={onSortingChange}
            onTabChange={onTabChange}
            onViewChange={onViewChange}
          />
        </div>
      </Card>
    </>
  );
}
