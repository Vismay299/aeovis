"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { SortingState, Updater } from "@tanstack/react-table";
import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import { BackButton, PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { SearchTabStrip } from "@/components/app/search-tabs/SearchTabStrip";
import { keys, stableStringify } from "@/lib/query/keys";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import {
  BACKLINKS_DEFAULT_SORT,
  DEFAULT_BACKLINKS_PAGE_SIZE,
  backlinksSearchSchema,
  type BacklinksTab,
} from "@/shared/backlinks";
import { toScopeSearchParam, type ResearchScope } from "@/shared/researchScope";
import { BacklinksSearchCard } from "./BacklinksSearchCard";
import { BacklinksBody } from "./BacklinksPageContent";
import { useBacklinksFilters } from "./hooks/useBacklinksFilters";
import { useBacklinksSearchHistory } from "./hooks/useBacklinksSearchHistory";
import {
  useBacklinksSearchTabs,
  type BacklinksTabInput,
} from "./hooks/useBacklinksSearchTabs";
import { useBacklinksLiveMode } from "./hooks/useBacklinksLiveMode";
import {
  useBacklinksPageData,
  type BacklinksSearchState,
} from "./hooks/useBacklinksPageData";
import { useBacklinksDomainExpansion } from "./hooks/useBacklinksDomainExpansion";
import { trackBacklinksEvent } from "./telemetry";

const defaultSearchState: BacklinksSearchState = {
  target: undefined,
  scope: undefined,
  tab: "backlinks",
  page: 1,
  size: DEFAULT_BACKLINKS_PAGE_SIZE,
  sort: undefined,
  order: undefined,
  view: undefined,
  includeSpam: false,
};

// Search params are strings, while the shared schema models this toggle as a
// boolean. Coerce only this page's URL value so toggling "All links" survives
// a navigation update without changing the shared query-state parser.
const backlinksPageSearchSchema = {
  safeParse(value: unknown) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const candidate = value as Record<string, unknown>;
      if (candidate.includeSpam === "true" || candidate.includeSpam === "false") {
        return backlinksSearchSchema.safeParse({
          ...candidate,
          includeSpam: candidate.includeSpam === "true",
        });
      }
    }
    return backlinksSearchSchema.safeParse(value);
  },
};

export function BacklinksPage({ brandKey: propBrandKey }: { brandKey?: string }) {
  const workspace = useWorkspace();
  const brandKey = propBrandKey || workspace?.brandKey || "";
  const isEnabled = Boolean(workspace?.features?.backlinks);

  const [searchState, setSearchState] = useUrlSearchState<BacklinksSearchState>(
    backlinksPageSearchSchema,
    defaultSearchState,
  );

  const filters = useBacklinksFilters();
  const { isLive, enterLiveMode } = useBacklinksLiveMode(searchState.target);

  const { history, isLoaded: historyLoaded, addSearch, removeHistoryItem } =
    useBacklinksSearchHistory(brandKey);

  const sorting = useMemo<SortingState>(() => {
    const currentTab = searchState.tab ?? "backlinks";
    const fallback = BACKLINKS_DEFAULT_SORT[currentTab];
    const field = searchState.sort ?? fallback.field;
    const order =
      searchState.order ?? (searchState.sort ? "desc" : fallback.order);
    return [{ id: field, desc: order === "desc" }];
  }, [searchState.order, searchState.sort, searchState.tab]);

  const updateSearch = useCallback(
    (updates: Partial<BacklinksSearchState>) => {
      setSearchState(updates, { replace: true });
    },
    [setSearchState],
  );

  const handleSortingChange = useCallback(
    (updater: Updater<SortingState>) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      updateSearch({
        sort: first?.id,
        order: first?.desc ? "desc" : "asc",
        page: 1,
      });
    },
    [sorting, updateSearch],
  );

  const handleSearchSubmit = useCallback(
    (
      values: { target: string; scope: ResearchScope },
      maxUsd?: number,
    ) => {
      if (maxUsd != null) {
        enterLiveMode(values.target);
      }
      addSearch({ target: values.target, scope: values.scope });
      trackBacklinksEvent("backlinks:lookup", {
        scope: values.scope,
        cached: maxUsd == null,
      });
      updateSearch({
        target: values.target,
        scope: toScopeSearchParam(values.target, values.scope),
        tab: "backlinks",
        page: 1,
        sort: undefined,
        order: undefined,
      });
    },
    [addSearch, enterLiveMode, updateSearch],
  );

  const handleTabNavigate = useCallback(
    (input: BacklinksTabInput | null) => {
      if (!input) {
        updateSearch({
          target: undefined,
          scope: undefined,
          tab: undefined,
          page: undefined,
          sort: undefined,
          order: undefined,
        });
        return;
      }
      updateSearch({
        target: input.target,
        scope: toScopeSearchParam(input.target, input.scope),
        tab: "backlinks",
        page: 1,
        sort: undefined,
        order: undefined,
      });
    },
    [updateSearch],
  );

  const searchTabs = useBacklinksSearchTabs({
    brandKey,
    target: searchState.target,
    scope: searchState.scope,
    onNavigate: handleTabNavigate,
  });

  const pageData = useBacklinksPageData({
    brandKey,
    searchState,
    filters,
    isLive,
  });

  const lastRecordedSearchRef = useRef<string>("");
  // Track search in history when overview data resolves
  useEffect(() => {
    if (pageData.overviewData && searchState.target) {
      const key = `${searchState.target}:${pageData.overviewData.scope}`;
      if (lastRecordedSearchRef.current !== key) {
        lastRecordedSearchRef.current = key;
        addSearch({
          target: searchState.target,
          scope: pageData.overviewData.scope,
        });
      }
    }
  }, [addSearch, pageData.overviewData, searchState.target]);

  const domainExpansion = useBacklinksDomainExpansion({
    brandKey,
    target: searchState.target,
    scope: searchState.scope,
    tab: searchState.tab ?? "backlinks",
    view: searchState.view,
    includeSpam: searchState.includeSpam,
    rows: pageData.rowsQuery.data?.rows ?? [],
    isLive,
  });

  if (!isEnabled) {
    return (
      <EmptyState
        title="This page is not available for your workspace yet."
        description="Ask Perceev support to turn on backlinks."
      />
    );
  }

  const tabControls = (
    <SearchTabStrip
      activeTabId={searchTabs.activeTabId}
      tabs={searchTabs.tabs}
      onSelect={searchTabs.selectTab}
      onClose={searchTabs.closeTab}
      onViewed={searchTabs.markTabViewed}
      getQueryConfig={(tab) => ({
        queryKey: keys.backlinksOverview(
          brandKey,
          stableStringify({
            target: tab.input.target,
            scope: tab.input.scope,
            cacheOnly: true,
          }),
        ),
      })}
    />
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backlinks"
        description="Understand who links to a site, what changed recently, and which pages attract links."
        backLink={
          searchState.target ? (
            <BackButton
              onClick={() =>
                updateSearch({
                  target: undefined,
                  scope: undefined,
                  tab: undefined,
                  page: undefined,
                  sort: undefined,
                  order: undefined,
                })
              }
            >
              Recent searches
            </BackButton>
          ) : undefined
        }
      />

      <BacklinksSearchCard
        brandKey={brandKey}
        initialValues={{
          target: searchState.target ?? "",
          scope: searchState.scope ?? "subdomains",
        }}
        onSubmit={handleSearchSubmit}
        pending={pageData.overviewQuery.isFetching}
      />

      <BacklinksBody
        brandKey={brandKey}
        history={history}
        historyLoaded={historyLoaded}
        data={pageData}
        searchState={searchState}
        filters={filters}
        sorting={sorting}
        domainExpansion={domainExpansion}
        tabControls={tabControls}
        onRunLookup={(_maxUsd) => {
          enterLiveMode();
        }}
        onPageChange={(page) => updateSearch({ page })}
        onPageSizeChange={(size) => updateSearch({ size, page: 1 })}
        onRemoveHistoryItem={removeHistoryItem}
        onSelectHistoryItem={(item) =>
          handleSearchSubmit({ target: item.target, scope: item.scope })
        }
        onSortingChange={handleSortingChange}
        onTabChange={(tab) => {
          trackBacklinksEvent("backlinks:tab", { tab });
          updateSearch({ tab, page: 1, sort: undefined, order: undefined });
        }}
        onViewChange={(view) => updateSearch({ view, page: 1 })}
        onHideSpamChange={(hideSpam) =>
          updateSearch({ includeSpam: !hideSpam, page: 1 })
        }
      />
    </div>
  );
}
