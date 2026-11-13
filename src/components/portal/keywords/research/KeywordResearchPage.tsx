// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { BackButton, PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { ErrorState } from "@/components/app/ErrorState";
import { RecentSearches } from "@/components/app/RecentSearches";
import { PageFrame } from "@/components/app/PageFrame";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useKeywordResearchController } from "./hooks/useKeywordResearchController";
import { KeywordResearchSearchBar } from "./KeywordResearchSearchBar";
import { KeywordResearchLoadingState } from "./KeywordResearchLoadingState";
import { KeywordResearchEmptyState } from "./KeywordResearchEmptyState";
import { KeywordNotLoadedCard } from "./KeywordNotLoadedCard";
import { KeywordResearchResults } from "./KeywordResearchResults";
import { OverviewStats } from "./OverviewStats";
import { AreaTrendChart } from "./AreaTrendChart";
import { SerpAnalysisCard } from "./SerpAnalysisCard";
import { SaveKeywordsDialog } from "./SaveKeywordsDialog";
import { LOCATION_OPTIONS } from "@/shared/keyword-locations";
import { trackKeywordResearch } from "../telemetry";
import { isApiError } from "@/lib/query/fetchJson";

export function KeywordResearchPage() {
  const c = useKeywordResearchController();
  const [saveOpen, setSaveOpen] = useState(false);
  const selectedRow = c.rows.find((row) => row.keyword === c.selectedKeyword) ?? c.rows[0];
  const locationLabel = LOCATION_OPTIONS.find((loc) => loc.code === c.params.loc)?.label ?? "your selected country";
  const options = { resultLimit: c.params.kLimit, mode: c.params.mode, clickstream: c.params.cs, groupKeywords: c.params.grp };
  const searchInput = {
    brand_key: c.brandKey,
    keyword: c.params.q,
    locationCode: c.params.loc,
    languageCode: c.location?.languageCode ?? "en",
    resultLimit: c.params.kLimit,
    mode: c.params.mode,
    clickstream: c.params.cs,
    groupKeywords: c.params.grp,
  };
  const sortedRows = [...c.rows].sort((a, b) => {
    if (c.params.sort === "keyword") {
      const comparison = a.keyword.localeCompare(b.keyword);
      return c.params.order === "desc" ? -comparison : comparison;
    }
    const value = (row: typeof a) => {
      switch (c.params.sort) {
        case "keywordDifficulty": return row.keywordDifficulty ?? -1;
        case "cpc": return row.cpc ?? -1;
        case "competition": return row.competition ?? -1;
        default: return row.searchVolume ?? -1;
      }
    };
    const difference = value(a) - value(b);
    return c.params.order === "desc" ? -difference : difference;
  });
  const sortRows = (field: "searchVolume" | "keywordDifficulty" | "cpc" | "competition" | "keyword") => {
    c.setParams({ sort: field, order: c.params.sort === field ? (c.params.order === "desc" ? "asc" : "desc") : "desc" });
  };
  const isCacheMiss = Boolean(c.params.q && !c.liveMode && c.research.data?.notCached);
  const isLoadingCache = Boolean(c.params.q && c.research.isPending);
  const retryUnavailable = c.research.error && isApiError(c.research.error) && ["unknown_location", "research_invalid"].includes(c.research.error.code);
  const requestSearch = (maxUsd: number) => {
    trackKeywordResearch("keywords:search", { locationCode: c.locationPref });
    c.runSearch(maxUsd);
  };
  const requestSerp = (maxUsd: number) => {
    trackKeywordResearch("keywords:serp", {});
    c.runSerp(maxUsd);
  };
  const showSaveDialog = () => setSaveOpen(true);

  if (!c.featureEnabled) {
    return <PageFrame><EmptyState title="This page is not available for your workspace yet." description="Ask Perceev support to turn on keyword research." /></PageFrame>;
  }

  return <PageFrame className="min-w-0 overflow-x-hidden">
    <PageHeader title="Keyword Research" description="Discover keyword ideas, search demand, and ranking opportunities." backLink={c.params.q ? <BackButton onClick={() => { c.setParams({ q: "" }); c.setDraft(""); }}>Recent searches</BackButton> : undefined} />
    <KeywordResearchSearchBar brandKey={c.brandKey} draft={c.draft} onDraftChange={c.setDraft} locationCode={c.locationPref} onLocationChange={(code) => { c.setLocationPref(code); c.setAreaDraft(undefined); c.setParams({ loc: code, locName: "" }); }} locationName={c.areaDraft} onLocationNameChange={c.setAreaDraft} localVolumeUsd={c.localVolumeUsd} options={options} onOptionsChange={(next) => c.setParams({ kLimit: next.resultLimit, mode: next.mode, cs: next.clickstream, grp: next.groupKeywords })} onRun={requestSearch} pending={c.research.isFetching && c.liveMode} warnings={c.researchQuote.data?.warnings ?? []} priceChanged={c.priceChanged} onClosePriceReview={() => c.setPriceChanged(null)} />

    {!c.params.q ? <RecentSearches items={c.history.history} loaded={c.history.isLoaded} onRemove={c.history.removeHistoryItem} renderLink={(item, props) => <button {...props} onClick={() => { c.setDraft(item.keyword); c.setParams({ q: item.keyword, loc: item.locationCode, locName: item.locationName ?? "" }, { replace: false }); }}>{props.children}</button>} getTitle={(item) => item.keyword} getSubtitle={(item) => item.locationName ?? (LOCATION_OPTIONS.find((loc) => loc.code === item.locationCode)?.label ?? "Country")} emptyTitle="Enter a keyword to get started" emptyDescription="Search for any keyword to see volume, difficulty, CPC, and related keyword ideas." /> : null}

    {c.params.q && (isLoadingCache || (c.research.isFetching && c.liveMode)) ? <KeywordResearchLoadingState /> : null}
    {c.params.q && c.research.isError ? <ErrorState title="Keyword data could not be loaded" message={c.research.error instanceof Error ? c.research.error.message : "Keyword data is unavailable right now. Please retry."} onRetry={retryUnavailable ? undefined : c.retryResearch} /> : null}
    {isCacheMiss ? <KeywordNotLoadedCard brandKey={c.brandKey} keyword={c.params.q} input={searchInput} onRun={requestSearch} pending={c.research.isFetching} /> : null}
    {c.params.q && !isLoadingCache && !isCacheMiss && !c.research.isError && c.research.data && c.rows.length === 0 ? <KeywordResearchEmptyState title="Not enough keyword data for this query yet" description={`We could not find keyword opportunities for “${c.params.q}” in ${locationLabel}.`} /> : null}

    {c.params.q && c.rows.length > 0 ? <>
      {c.tabs.tabs.length > 1 ? <div className="hidden gap-2 overflow-x-auto md:flex">{c.tabs.tabs.map((tab) => <Button key={tab.id} size="sm" variant={tab.input.keyword === c.params.q ? "secondary" : "outline"} onClick={() => { c.setDraft(tab.input.keyword); c.setParams({ q: tab.input.keyword, loc: tab.input.locationCode, locName: tab.input.locationName ?? "" }); }}>{tab.label}</Button>)}</div> : null}
      <div className="grid min-w-0 gap-4 xl:grid-cols-5">
        <section className="min-w-0 space-y-4 xl:col-span-3">
          <div className="hidden xl:block">{selectedRow ? <OverviewStats keyword={selectedRow.keyword} volume={selectedRow.searchVolume} cpc={selectedRow.cpc} competition={selectedRow.competition} difficulty={selectedRow.keywordDifficulty} intent={selectedRow.intent} /> : null}</div>
          <div className="md:hidden"><Tabs value={c.mobileTab} onValueChange={c.setMobileTab}><TabsList className="grid w-full grid-cols-2"><TabsTrigger value="keywords">Keywords ({c.rows.length})</TabsTrigger><TabsTrigger value="serp">SERP Analysis</TabsTrigger></TabsList></Tabs></div>
          <div className={c.mobileTab === "serp" ? "hidden md:block xl:hidden" : ""}>
            <KeywordResearchResults brandKey={c.brandKey} rows={sortedRows} seed={c.params.q} groupKeywords={c.params.grp} selectedKeyword={c.selectedKeyword} onSelectKeyword={c.setSelectedKeyword} selectedKeywords={c.selectedKeywords} onToggleKeyword={c.toggleSelected} mode={c.params.mode} page={c.page} pageSize={c.pageSize} sort={c.params.sort} order={c.params.order} onSort={sortRows} onPage={c.setPage} onPageSize={c.setPageSize} onSaveSelected={showSaveDialog} />
          </div>
        </section>
        <aside className={`min-w-0 space-y-4 xl:col-span-2 ${c.mobileTab === "keywords" ? "hidden md:block" : ""}`}>
          {selectedRow ? <div className="hidden md:block xl:hidden"><OverviewStats keyword={selectedRow.keyword} volume={selectedRow.searchVolume} cpc={selectedRow.cpc} competition={selectedRow.competition} difficulty={selectedRow.keywordDifficulty} intent={selectedRow.intent} /></div> : null}
          {selectedRow ? <div className="hidden md:block"><AreaTrendChart row={selectedRow} /></div> : null}
          {c.selectedKeyword ? <SerpAnalysisCard brandKey={c.brandKey} keyword={c.selectedKeyword} locationCode={c.params.loc} languageCode={c.location?.languageCode ?? "en"} result={c.serp.data} top20Result={c.serpTop20Result} pending={c.serpPending} cacheOnlyMiss={Boolean(c.serp.data?.notCached)} maxUsd={c.serpMaxUsd} depth={c.serpDepth} onRun={requestSerp} onLoadTop100={c.runSerpDeep} onShowTop20={c.showSerpTop20} onRetry={() => void c.serp.refetch()} deepCrawlFailed={c.serpDepth === 100 && c.serp.isError} error={c.serp.isError ? (c.serp.error instanceof Error ? c.serp.error.message : "Search results are unavailable right now. Please retry.") : undefined} /> : null}
        </aside>
      </div>
      <SaveKeywordsDialog open={saveOpen} onOpenChange={setSaveOpen} brandKey={c.brandKey} keywords={c.selectedKeywords} locationCode={c.params.loc} languageCode={c.location?.languageCode ?? "en"} areaName={c.params.locName || undefined} onSaved={c.clearSelectedKeywords} />
    </> : null}
  </PageFrame>;
}
