"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/DomainOverviewPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Info } from "lucide-react";
import { BackButton, PageHeader } from "@/components/app/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DataTableTabs } from "@/components/app/table/DataTableToolbar";
import { TabsTrigger } from "@/components/ui/tabs";
import { RecentSearches } from "@/components/app/RecentSearches";
import { QueryError } from "@/components/app/QueryState";
import { SearchTabStrip } from "@/components/app/search-tabs/SearchTabStrip";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { buildSearch } from "@/shared/query/urlState";
import { keys, stableStringify } from "@/shared/query/keys";
import {
  RESEARCH_SCOPE_LABELS,
  defaultScopeForPath,
  isScopeAllowedForInput,
  parseResearchTarget,
  toScopeSearchParam,
  type ResearchScope,
} from "@/shared/researchScope";
import {
  isLabsLocationCode,
  workspaceMarket,
  LOCATIONS,
} from "@/shared/keyword-locations";
import {
  DEFAULT_DOMAIN_PAGE_SIZE,
  DOMAIN_SEARCH_DEFAULTS,
  domainSearchSchema,
  buildDomainFiltersClearSearchUpdate,
  getDomainRouteState,
  getDefaultSortOrder,
  getResearchInputPath,
  toSortMode,
  toSortOrderSearchParam,
  toSortSearchParam,
  type DomainOverviewRouteState,
  type DomainSearchParams,
  type DomainSortMode,
  type DomainTab,
  type SortOrder,
} from "@/shared/domain";
import { DomainSearchCard } from "./DomainSearchCard";
import { domainPriceChangeFromError } from "./DomainPriceChangeReview";
import { DomainQuickPicks } from "./DomainQuickPicks";
import { DomainOverviewLoadingState } from "./DomainOverviewLoadingState";
import { DomainNotLoadedCard } from "./DomainNotLoadedCard";
import { DomainOverviewCard } from "./DomainOverviewCard";
import { KeywordsTab } from "./KeywordsTab";
import { PagesTab } from "./PagesTab";
import { CompetitorsTab } from "./CompetitorsTab";
import { useDomainLiveMode } from "./hooks/useDomainLiveMode";
import {
  useDomainOverviewQuery,
  type DomainOverviewOkResponse,
  type DomainOverviewResponse,
} from "./hooks/useDomainOverviewQuery";
import { useDeclaredCompetitors } from "./hooks/useDeclaredCompetitors";
import type { DomainCompetitorsResponse } from "./hooks/useDomainCompetitors";
import {
  useDomainSearchTabs,
  formatDomainTabLabel,
  type DomainTabInput,
} from "./hooks/useDomainSearchTabs";
import {
  useDomainSearchHistory,
  type DomainSearchHistoryItem,
} from "./hooks/useDomainSearchHistory";
import { trackDomainEvent } from "./telemetry";

type SearchUpdate = Partial<DomainSearchParams>;

const KEYWORDS_ONLY_SORTS: ReadonlySet<DomainSortMode> = new Set([
  "rank",
  "score",
  "cpc",
]);

export type DomainOverviewPageProps = {
  brandKey: string;
  brand?: {
    website_host?: string | null;
    default_location_code?: number | null;
    default_language_code?: string | null;
  } | null;
  hasProjectMemory?: boolean;
  canSaveKeywords?: boolean;
};

export function DomainOverviewPage({
  brandKey,
  brand,
  hasProjectMemory = true,
  canSaveKeywords = true,
}: DomainOverviewPageProps) {
  const defaultLocationCode = useMemo(() => {
    const loc = brand ? workspaceMarket(brand).locationCode : 2840;
    return isLabsLocationCode(loc) ? loc : 2840;
  }, [brand]);

  const [searchParams] = useUrlSearchState(
    domainSearchSchema,
    DOMAIN_SEARCH_DEFAULTS,
  );
  const currentSearchParams = useSearchParams();
  const pathname = usePathname();
  const setSearchParams = useCallback(
    (patch: SearchUpdate, options?: { replace?: boolean }) => {
      if (typeof window === "undefined") return;
      const search = buildSearch(
        new URLSearchParams(currentSearchParams.toString()),
        patch,
        DOMAIN_SEARCH_DEFAULTS,
      );
      const target = `${pathname || "/portal/domain"}${search}`;
      if (options?.replace === false) {
        window.history.pushState(null, "", target);
      } else {
        window.history.replaceState(null, "", target);
      }
    },
    [currentSearchParams, pathname],
  );

  const routeState = useMemo<DomainOverviewRouteState>(
    () => getDomainRouteState(searchParams, defaultLocationCode),
    [searchParams, defaultLocationCode],
  );

  const { liveMode, enableLiveMode } = useDomainLiveMode(brandKey);
  const [liveMaxUsd, setLiveMaxUsd] = useState<number | undefined>(undefined);
  const queryClient = useQueryClient();

  // Search card form input states
  const [domainInput, setDomainInput] = useState(routeState.domain);
  const [scopeInput, setScopeInput] = useState<ResearchScope>(routeState.scope);
  const [locationInput, setLocationInput] = useState(routeState.locationCode);
  const [sortInput, setSortInput] = useState<DomainSortMode>(routeState.sort);
  const [validationError, setValidationError] = useState<string | null>(null);

  const userPickedScope = useRef(false);

  // Sync inputs when URL routeState changes
  useEffect(() => {
    userPickedScope.current = false;
    setDomainInput(routeState.domain);
    setScopeInput(routeState.scope);
    setLocationInput(routeState.locationCode);
    setSortInput(routeState.sort);
    setValidationError(null);
  }, [
    routeState.domain,
    routeState.locationCode,
    routeState.scope,
    routeState.sort,
  ]);

  const handleDomainChange = useCallback((nextDomain: string) => {
    setDomainInput(nextDomain);
    setValidationError(null);
    if (userPickedScope.current) return;
    const path = getResearchInputPath(nextDomain);
    const nextScope = defaultScopeForPath(path);
    setScopeInput(nextScope);
  }, []);

  const handleScopeChange = useCallback((nextScope: ResearchScope) => {
    userPickedScope.current = true;
    setScopeInput(nextScope);
    setValidationError(null);
  }, []);

  const handleLocationChange = useCallback((nextLoc: number) => {
    setLocationInput(nextLoc);
    // If domain is already loaded, update search parameter directly
    if (routeState.domain) {
      setSearchParams({
        loc: nextLoc === defaultLocationCode ? undefined : nextLoc,
        page: undefined,
      });
    }
  }, [defaultLocationCode, routeState.domain, setSearchParams]);

  const handleSortChange = useCallback((nextSort: DomainSortMode) => {
    setSortInput(nextSort);
    if (routeState.domain) {
      const nextOrder = getDefaultSortOrder(nextSort);
      setSearchParams({
        sort: toSortSearchParam(nextSort),
        order: toSortOrderSearchParam(nextSort, nextOrder),
        page: undefined,
      });
    }
  }, [routeState.domain, setSearchParams]);

  // Overview Query
  const trimmedDomain = routeState.domain.trim();
  const overviewQuery = useDomainOverviewQuery({
    brandKey,
    domain: trimmedDomain,
    scope: routeState.scope,
    locationCode: routeState.sentLocationCode,
    cacheOnly: !liveMode,
    maxUsd: liveMaxUsd,
    enabled: Boolean(trimmedDomain),
  });

  const overview = overviewQuery.data ?? null;
  const isOverviewOk = overview?.status === "ok";
  const overviewOkData: DomainOverviewOkResponse | null = isOverviewOk
    ? overview
    : null;
  const isNotCached = overview?.status === "not_cached";
  const overviewPriceChange = domainPriceChangeFromError(overviewQuery.error);

  // Declared competitors for quick picks
  const declaredQuery = useDeclaredCompetitors(brandKey);
  const declaredData = declaredQuery.data;

  // Search History
  const {
    history,
    isLoaded: historyLoaded,
    addSearch,
    removeHistoryItem,
  } = useDomainSearchHistory(brandKey);

  // Add to history on successful overview fetch
  useEffect(() => {
    if (!overviewOkData || !routeState.domain) return;
    addSearch({
      domain: routeState.domain,
      scope: routeState.scope,
      sort: routeState.sort,
      tab: routeState.tab,
      locationCode: routeState.locationCode,
    });
  }, [addSearch, overviewOkData, routeState.domain, routeState.locationCode, routeState.scope, routeState.sort, routeState.tab]);

  // Search Tabs
  const searchTabs = useDomainSearchTabs(brandKey);

  useEffect(() => {
    if (!routeState.domain) return;
    const tabInput: DomainTabInput = {
      domain: routeState.domain,
      scope: routeState.scope,
      sort: routeState.sort,
      order: routeState.order,
      tab: routeState.tab,
      loc: routeState.sentLocationCode,
    };
    const label = formatDomainTabLabel(tabInput, defaultLocationCode);
    const existing = searchTabs.findMatchingTab(tabInput);
    if (!existing) {
      searchTabs.openTab({ label, input: tabInput });
    } else if (searchTabs.activeTabId !== existing.id) {
      searchTabs.setActiveTab(existing.id);
    }
  }, [
    routeState.domain,
    routeState.scope,
    routeState.sort,
    routeState.order,
    routeState.tab,
    routeState.sentLocationCode,
    defaultLocationCode,
    searchTabs,
  ]);

  // Submit search from SearchCard
  const handleSearchSubmit = useCallback((maxUsd: number) => {
    const parsed = parseResearchTarget(domainInput, scopeInput);
    if (!parsed.ok) {
      setValidationError(parsed.message);
      return;
    }
    setValidationError(null);
    setLiveMaxUsd(maxUsd);
    enableLiveMode();

    const target = parsed.target;
    setSearchParams({
      ...buildDomainFiltersClearSearchUpdate(),
      domain: target.display,
      scope: toScopeSearchParam(target.display, target.scope),
      subdomains: undefined,
      sort: toSortSearchParam(sortInput),
      order: toSortOrderSearchParam(sortInput, getDefaultSortOrder(sortInput)),
      tab: routeState.tab === "keywords" ? undefined : routeState.tab,
      loc: locationInput === defaultLocationCode ? undefined : locationInput,
      page: undefined,
      size: undefined,
    });
  }, [
    domainInput,
    scopeInput,
    sortInput,
    locationInput,
    defaultLocationCode,
    routeState.tab,
    enableLiveMode,
    setSearchParams,
  ]);

  // Quick pick selection (fills input & scope only, no request)
  const handleQuickPick = useCallback((pickDomain: string, pickScope: ResearchScope) => {
    userPickedScope.current = true;
    setDomainInput(pickDomain);
    setScopeInput(pickScope);
    setValidationError(null);
  }, []);

  // History item selection
  const handleHistorySelect = useCallback((item: DomainSearchHistoryItem) => {
    const histLoc = item.locationCode ?? defaultLocationCode;
    setSearchParams({
      ...buildDomainFiltersClearSearchUpdate(),
      domain: item.domain,
      scope: toScopeSearchParam(item.domain, item.scope ?? "domain"),
      subdomains: undefined,
      sort: toSortSearchParam(item.sort ?? "traffic"),
      order: undefined,
      tab: item.tab === "keywords" ? undefined : item.tab,
      loc: histLoc === defaultLocationCode ? undefined : histLoc,
      page: undefined,
      size: undefined,
    });
  }, [defaultLocationCode, setSearchParams]);

  // Sort click from table headers
  const handleSortColumnClick = useCallback((nextSort: DomainSortMode) => {
    const nextOrder: SortOrder =
      nextSort === routeState.sort
        ? routeState.order === "asc"
          ? "desc"
          : "asc"
        : getDefaultSortOrder(nextSort);

    setSearchParams({
      sort: toSortSearchParam(nextSort),
      order: toSortOrderSearchParam(nextSort, nextOrder),
      page: undefined,
    });
  }, [routeState.order, routeState.sort, setSearchParams]);

  const handlePageChange = useCallback((nextPage: number) => {
    const safe = Math.max(1, Math.floor(nextPage));
    setSearchParams({ page: safe === 1 ? undefined : safe });
  }, [setSearchParams]);

  const handlePageSizeChange = useCallback((nextSize: number) => {
    setSearchParams({
      size: nextSize === DEFAULT_DOMAIN_PAGE_SIZE ? undefined : nextSize,
      page: undefined,
    });
  }, [setSearchParams]);

  const handleTabChange = useCallback((nextTab: string) => {
    const tab = nextTab as DomainTab;
    trackDomainEvent("domain_overview:tab", { tab });
    const fallbackSortNeeded =
      tab !== "keywords" && KEYWORDS_ONLY_SORTS.has(routeState.sort);

    const update: SearchUpdate = {
      tab: tab === "keywords" ? undefined : tab,
      page: undefined,
    };
    if (fallbackSortNeeded) {
      update.sort = "traffic";
      update.order = getDefaultSortOrder("traffic");
    }
    setSearchParams(update);
  }, [routeState.sort, setSearchParams]);

  // Run lookup from NotLoaded card
  const handleRunLookup = useCallback((maxUsd: number) => {
    setLiveMaxUsd(maxUsd);
    enableLiveMode();
  }, [enableLiveMode]);

  // A competitor was just stored in F07. Patch the cached overview and the
  // cached competitors rows so the badge and the button state update without a
  // refetch: in live mode either refetch would be another paid call, and this
  // gesture approved no such call.
  const handleCompetitorAdded = useCallback(
    (domain: string) => {
      queryClient.setQueriesData<DomainOverviewResponse>(
        { queryKey: ["domainOverview", brandKey] },
        (previous) =>
          previous && previous.status === "ok" && previous.domain === domain
            ? { ...previous, isDeclaredCompetitor: true }
            : previous,
      );
      queryClient.setQueriesData<DomainCompetitorsResponse>(
        { queryKey: ["domainCompetitors", brandKey] },
        (previous) =>
          previous && previous.status === "ok"
            ? {
                ...previous,
                competitors: previous.competitors.map((item) =>
                  item.domain === domain
                    ? { ...item, isDeclaredCompetitor: true }
                    : item,
                ),
              }
            : previous,
      );
      void queryClient.invalidateQueries({
        queryKey: keys.declaredCompetitors(brandKey),
      });
    },
    [brandKey, queryClient],
  );

  const tabsBar = (
    <DataTableTabs
      value={routeState.tab}
      onValueChange={handleTabChange}
    >
      <TabsTrigger value="keywords">Top Keywords</TabsTrigger>
      <TabsTrigger value="pages">Top Pages</TabsTrigger>
      <TabsTrigger value="competitors">Competitors</TabsTrigger>
    </DataTableTabs>
  );

  const displayTarget = overviewOkData?.displayTarget ?? routeState.domain;
  const countryName =
    overview?.market?.country ??
    (routeState.locationCode ? LOCATIONS[routeState.locationCode] : undefined) ??
    "this location";

  return (
    <div className="overflow-x-hidden px-4 py-4 md:px-6 md:py-6 pb-24 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title="Domain Overview"
          description="Analyze any domain's SEO profile: traffic, keywords, and top pages."
          backLink={
            routeState.domain ? (
              <BackButton
                onClick={() => {
                  searchTabs.setActiveTab(null);
                  setSearchParams({
                    ...buildDomainFiltersClearSearchUpdate(),
                    domain: "",
                    scope: undefined,
                    subdomains: undefined,
                    sort: undefined,
                    order: undefined,
                    tab: undefined,
                    loc: undefined,
                    page: undefined,
                    size: undefined,
                  });
                }}
              >
                Recent searches
              </BackButton>
            ) : undefined
          }
        />

        <div className="space-y-2">
          <DomainSearchCard
            brandKey={brandKey}
            domain={domainInput}
            scope={scopeInput}
            locationCode={locationInput}
            sort={sortInput}
            isLoading={overviewQuery.isLoading}
            validationError={validationError}
            priceChanged={overviewPriceChange}
            onDomainChange={handleDomainChange}
            onScopeChange={handleScopeChange}
            onLocationChange={handleLocationChange}
            onSortChange={handleSortChange}
            onSubmit={handleSearchSubmit}
          />

          {declaredData ? (
            <DomainQuickPicks
              available={declaredData.available}
              ownHost={declaredData.ownHost}
              competitors={declaredData.competitors}
              onPick={handleQuickPick}
            />
          ) : null}
        </div>

        {routeState.domain ? (
          <SearchTabStrip
            tabs={searchTabs.tabs}
            activeTabId={searchTabs.activeTabId}
            onSelect={(tab) => {
              searchTabs.setActiveTab(tab.id);
              setSearchParams({
                ...buildDomainFiltersClearSearchUpdate(),
                domain: tab.input.domain,
                scope: toScopeSearchParam(tab.input.domain, tab.input.scope ?? "domain"),
                subdomains: undefined,
                sort: toSortSearchParam(tab.input.sort ?? "traffic"),
                order: undefined,
                tab: tab.input.tab === "keywords" ? undefined : tab.input.tab,
                loc: tab.input.loc === defaultLocationCode ? undefined : tab.input.loc,
                page: undefined,
                size: undefined,
              });
            }}
            onClose={(tabId) => {
              const { closedActive, nextActiveTab } = searchTabs.closeTab(tabId);
              if (closedActive) {
                if (nextActiveTab) {
                  setSearchParams({
                    ...buildDomainFiltersClearSearchUpdate(),
                    domain: nextActiveTab.input.domain,
                    scope: toScopeSearchParam(nextActiveTab.input.domain, nextActiveTab.input.scope ?? "domain"),
                    subdomains: undefined,
                    sort: toSortSearchParam(nextActiveTab.input.sort ?? "traffic"),
                    order: undefined,
                    tab: nextActiveTab.input.tab === "keywords" ? undefined : nextActiveTab.input.tab,
                    loc: nextActiveTab.input.loc === defaultLocationCode ? undefined : nextActiveTab.input.loc,
                    page: undefined,
                    size: undefined,
                  });
                } else {
                  setSearchParams({
                    ...buildDomainFiltersClearSearchUpdate(),
                    domain: "",
                    scope: undefined,
                    subdomains: undefined,
                    sort: undefined,
                    order: undefined,
                    tab: undefined,
                    loc: undefined,
                    page: undefined,
                    size: undefined,
                  });
                }
              }
            }}
            onViewed={searchTabs.markTabViewed}
            getQueryConfig={(tab) => ({
              queryKey: keys.domainOverview(
                brandKey,
                stableStringify({
                  domain: tab.input.domain,
                  scope: tab.input.scope ?? "domain",
                  locationCode: tab.input.loc,
                  cacheOnly: true,
                }),
              ),
            })}
          />
        ) : null}

        {!routeState.domain ? (
          <div className="pt-2">
            <RecentSearches
              items={history}
              loaded={historyLoaded}
              onRemove={removeHistoryItem}
              emptyIcon={Globe}
              emptyTitle="Enter a domain to get started"
              getTitle={(item) => item.domain}
              getSubtitle={(item) =>
                item.scope ? RESEARCH_SCOPE_LABELS[item.scope] : ""
              }
              renderLink={(item, props) => (
                <button
                  type="button"
                  onClick={() => handleHistorySelect(item)}
                  {...props}
                />
              )}
            />
          </div>
        ) : overviewQuery.isLoading ? (
          <DomainOverviewLoadingState />
        ) : isNotCached ? (
          <DomainNotLoadedCard
            brandKey={brandKey}
            displayTarget={displayTarget}
            domain={routeState.domain}
            country={countryName}
            scope={routeState.scope}
            locationCode={routeState.locationCode}
            onRun={handleRunLookup}
            pending={overviewQuery.isFetching}
          />
        ) : overviewQuery.isError && overviewPriceChange ? (
          <div role="status" className="text-sm text-muted-foreground">
            Review the updated price to run this lookup.
          </div>
        ) : overviewQuery.isError ? (
          <QueryError
            error={overviewQuery.error}
            fallback="Lookup failed."
            onRetry={() => void overviewQuery.refetch()}
            isRetrying={overviewQuery.isFetching}
          />
        ) : overviewOkData ? (
          <div className="space-y-4">
            {!overviewOkData.hasData ? (
              <Alert variant="info">
                <Info className="size-4" />
                <AlertDescription className="text-foreground">
                  Not enough data for this scope yet. Try another domain or a broader scope.
                </AlertDescription>
              </Alert>
            ) : null}

            <DomainOverviewCard
              data={overviewOkData}
              brandKey={brandKey}
              hasProjectMemory={hasProjectMemory}
              onCompetitorAdded={handleCompetitorAdded}
            />

            {routeState.tab === "pages" ? (
              <PagesTab
                brandKey={brandKey}
                target={overviewOkData.displayTarget}
                hostname={overviewOkData.domain}
                scope={overviewOkData.scope}
                routeState={routeState}
                tabs={tabsBar}
                liveMode={liveMode}
                setSearchParams={setSearchParams}
                onSortClick={handleSortColumnClick}
                onPageChange={handlePageChange}
                onPageSizeChange={handlePageSizeChange}
              />
            ) : routeState.tab === "competitors" ? (
              <CompetitorsTab
                brandKey={brandKey}
                displayTarget={overviewOkData.displayTarget}
                domain={overviewOkData.domain}
                scope={overviewOkData.scope}
                languageCode={overviewOkData.market.languageCode}
                routeState={routeState}
                tabs={tabsBar}
                hasProjectMemory={hasProjectMemory}
                onCompetitorAdded={handleCompetitorAdded}
              />
            ) : (
              <KeywordsTab
                brandKey={brandKey}
                target={overviewOkData.displayTarget}
                hostname={overviewOkData.domain}
                scope={overviewOkData.scope}
                routeState={routeState}
                tabs={tabsBar}
                liveMode={liveMode}
                canSaveKeywords={canSaveKeywords}
                hasData={overviewOkData.hasData}
                formLocationCode={locationInput}
                formLanguageCode={overviewOkData.market.languageCode}
                marketCountry={overviewOkData.market.country}
                shownLocationCode={overviewOkData.market.locationCode}
                setSearchParams={setSearchParams}
                onSortClick={handleSortColumnClick}
                onPageChange={handlePageChange}
                onPageSizeChange={handlePageSizeChange}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
