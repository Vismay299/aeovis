"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/PagesTab.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { TablePagination } from "@/components/app/table/TablePagination";
import { useExportRows } from "@/components/app/export/useExportRows";
import { QueryError } from "@/components/app/QueryState";
import type { ExportFormat } from "@/shared/export/exportRows";
import {
  PAGE_FILTER_FIELDS,
  buildPagesSearchUpdate,
  countPageFilterConditions,
  pagesToTable,
  DOMAIN_PAGE_SIZES,
  type DomainOverviewRouteState,
  type DomainSearchParams,
  type DomainSortMode,
  type PagesFilterValues,
} from "@/shared/domain";
import {
  MAX_DATAFORSEO_FILTER_CONDITIONS,
  RESEARCH_SCOPE_FILTER_SLOTS,
  type ResearchScope,
} from "@/shared/researchScope";
import { DomainFilterPanel } from "./DomainFilterPanel";
import { DomainPriceChangeReview, domainPriceChangeFromError } from "./DomainPriceChangeReview";
import { DomainPageLink } from "./DomainPageLink";
import { DomainPagesTable } from "./DomainPagesTable";
import { DomainTableToolbar } from "./DomainTableToolbar";
import { useDomainPagesQuery } from "./hooks/useDomainPagesQuery";
import { useDomainFilterPreferences } from "./hooks/useDomainFilterPreferences";

type SearchUpdate = Partial<DomainSearchParams>;

const PAGE_TEXT_FILTERS = [
  {
    key: "include" as const,
    label: "Include Page Terms",
    placeholder: "pricing, tools, guides",
  },
  {
    key: "exclude" as const,
    label: "Exclude Page Terms",
    placeholder: "blog, tag, archive",
  },
] as const;

const PAGE_RANGE_FILTERS = [
  { title: "Traffic", minKey: "minTraffic" as const, maxKey: "maxTraffic" as const },
  { title: "Keywords", minKey: "minVol" as const, maxKey: "maxVol" as const },
] as const;

type Props = {
  brandKey: string;
  target: string;
  hostname: string;
  scope: ResearchScope;
  routeState: DomainOverviewRouteState;
  tabs: ReactNode;
  liveMode: boolean;
  setSearchParams: (updates: SearchUpdate) => void;
  onSortClick: (sort: DomainSortMode) => void;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextSize: number) => void;
};

export function PagesTab({
  brandKey,
  target,
  hostname,
  scope,
  routeState,
  tabs,
  liveMode,
  setSearchParams,
  onSortClick,
  onPageChange,
  onPageSizeChange,
}: Props) {
  const [showFilters, setShowFilters] = useState(false);
  const [overBudgetLimit, setOverBudgetLimit] = useState<number | null>(null);
  const priceApprovalContext = JSON.stringify([
    brandKey,
    routeState.domain,
    routeState.scope,
    routeState.locationCode,
    routeState.pageSize,
  ]);
  const [priceApproval, setPriceApproval] = useState<{
    context: string;
    maxUsd: number;
  } | null>(null);
  const maxUsd =
    priceApproval?.context === priceApprovalContext
      ? priceApproval.maxUsd
      : 0.05;
  const runExport = useExportRows();

  const scopeSlots = RESEARCH_SCOPE_FILTER_SLOTS.pages[scope] ?? 0;
  const maxConditions = Math.max(0, MAX_DATAFORSEO_FILTER_CONDITIONS - scopeSlots);

  const {
    pageFilters: savedFilters,
    savePageFilters,
    clearPageFilters,
  } = useDomainFilterPreferences(brandKey, target);

  // Restore saved filters when URL has none
  useEffect(() => {
    if (!target) return;
    if (routeState.hasAppliedPageFilters) {
      setOverBudgetLimit(null);
      return;
    }

    const savedCount = countPageFilterConditions(savedFilters);
    if (savedCount === 0) {
      setOverBudgetLimit(null);
      return;
    }

    if (savedCount > maxConditions) {
      setOverBudgetLimit(maxConditions);
      return;
    }

    setOverBudgetLimit(null);
    setSearchParams(buildPagesSearchUpdate(savedFilters));
  }, [
    maxConditions,
    routeState.hasAppliedPageFilters,
    savedFilters,
    setSearchParams,
    target,
  ]);

  const activeFilterCount = useMemo(
    () => countPageFilterConditions(routeState.appliedPageFilters),
    [routeState.appliedPageFilters],
  );

  const pagesQuery = useDomainPagesQuery({
    brandKey,
    domain: routeState.domain,
    scope: routeState.scope,
    locationCode: routeState.locationCode,
    page: routeState.page,
    pageSize: routeState.pageSize,
    sortMode: routeState.sort,
    sortOrder: routeState.order,
    appliedFilters: routeState.appliedPageFilters,
    cacheOnly: !liveMode,
    maxUsd,
    enabled: Boolean(routeState.domain),
  });

  const rows = pagesQuery.data?.pages ?? [];
  const totalCount = pagesQuery.data?.totalCount ?? null;
  const priceChanged = domainPriceChangeFromError(pagesQuery.error);
  const queryError = pagesQuery.isError
    ? priceChanged ? (
        <DomainPriceChangeReview
          label="Review new price"
          pendingLabel="Loading page..."
          brandKey={brandKey}
          action="domain.pages.page"
          input={{
            domain: routeState.domain,
            scope: routeState.scope,
            locationCode: routeState.locationCode,
            pageSize: routeState.pageSize,
          }}
          pending={pagesQuery.isFetching}
          onRun={(approvedMaxUsd) => {
            setPriceApproval({
              context: priceApprovalContext,
              maxUsd: approvedMaxUsd,
            });
          }}
          dialogTitle="Review page price"
          confirmLabel="Load page"
          priceChanged={priceChanged}
        />
      ) : (
        <QueryError
          error={pagesQuery.error}
          fallback="Lookup failed."
          onRetry={() => void pagesQuery.refetch()}
          isRetrying={pagesQuery.isFetching}
        />
      )
    : null;

  const handleApplyFilters = useCallback(
    (values: PagesFilterValues) => {
      savePageFilters(values);
      setOverBudgetLimit(null);
      setSearchParams(buildPagesSearchUpdate(values));
    },
    [savePageFilters, setSearchParams],
  );

  const handleClearFilters = useCallback(() => {
    clearPageFilters();
    setOverBudgetLimit(null);
    const cleared: PagesFilterValues = {
      include: "",
      exclude: "",
      minTraffic: "",
      maxTraffic: "",
      minVol: "",
      maxVol: "",
    };
    setSearchParams(buildPagesSearchUpdate(cleared));
  }, [clearPageFilters, setSearchParams]);

  const handleExport = useCallback(
    (format: ExportFormat) => {
      const table = pagesToTable(rows);
      void runExport({
        format,
        feature: "domain_overview",
        headers: table.headers,
        rows: table.rows,
        filename: `${hostname || "domain"}-pages`,
      });
    },
    [hostname, rows, runExport],
  );

  const filterPanel = (
    <DomainFilterPanel
      activeFilterCount={activeFilterCount}
      appliedFilters={routeState.appliedPageFilters}
      fields={PAGE_FILTER_FIELDS}
      textFields={PAGE_TEXT_FILTERS}
      rangeFields={PAGE_RANGE_FILTERS}
      countConditions={countPageFilterConditions}
      maxConditions={maxConditions}
      onApply={handleApplyFilters}
      onClear={handleClearFilters}
    />
  );

  return (
    <div className="rounded-xl border border-border bg-card">
      {tabs}

      <DomainTableToolbar
        overBudgetLimit={overBudgetLimit}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters((prev) => !prev)}
        activeFilterCount={activeFilterCount}
        countLabel="pages"
        totalCount={totalCount}
        fallbackCount={rows.length}
        onExport={handleExport}
        filterPanel={filterPanel}
      />

      {queryError ? <div className="px-4 py-3">{queryError}</div> : null}

      {(!pagesQuery.isError || pagesQuery.data) ? <DomainPagesTable
        domain={hostname}
        rows={rows}
        sortMode={routeState.sort}
        currentSortOrder={routeState.order}
        onSortClick={onSortClick}
      /> : null}

      {(!pagesQuery.isError || pagesQuery.data) ? <div className="border-t border-border px-4 py-3">
        <TablePagination
          page={routeState.page}
          pageSize={routeState.pageSize}
          pageSizes={DOMAIN_PAGE_SIZES}
          totalCount={totalCount}
          hasNextPage={pagesQuery.data?.hasMore ?? false}
          isLoading={pagesQuery.isFetching}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          renderPageButton={DomainPageLink}
        />
      </div> : null}
    </div>
  );
}
