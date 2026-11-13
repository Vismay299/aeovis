"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/KeywordsTab.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Copy, FileDown, Save, Sheet } from "lucide-react";
import { toast } from "sonner";
import { TablePagination } from "@/components/app/table/TablePagination";
import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableBulkExportMenu,
} from "@/components/app/table/TableBulkActionBar";
import { useExportRows } from "@/components/app/export/useExportRows";
import { QueryError } from "@/components/app/QueryState";
import type { ExportFormat } from "@/lib/export/exportRows";
import {
  KEYWORD_FILTER_FIELDS,
  buildKeywordsSearchUpdate,
  countKeywordFilterConditions,
  keywordsToTable,
  DOMAIN_PAGE_SIZES,
  type DomainFilterValues,
  type DomainOverviewRouteState,
  type DomainSearchParams,
  type DomainSortMode,
  type KeywordsFilterValues,
} from "@/shared/domain";
import {
  MAX_DATAFORSEO_FILTER_CONDITIONS,
  RESEARCH_SCOPE_FILTER_SLOTS,
  type ResearchScope,
} from "@/shared/researchScope";
import { DomainFilterPanel } from "./DomainFilterPanel";
import { DomainPriceChangeReview, domainPriceChangeFromError } from "./DomainPriceChangeReview";
import { DomainKeywordsTable } from "./DomainKeywordsTable";
import { DomainPageLink } from "./DomainPageLink";
import { DomainTableToolbar } from "./DomainTableToolbar";
import { SaveDomainKeywordsDialog } from "./SaveDomainKeywordsDialog";
import { useDomainKeywordsQuery } from "./hooks/useDomainKeywordsQuery";
import { useDomainFilterPreferences } from "./hooks/useDomainFilterPreferences";

type SearchUpdate = Partial<DomainSearchParams>;

const KEYWORD_TEXT_FILTERS = [
  {
    key: "include" as const,
    label: "Include Terms",
    placeholder: "audit, checker, template",
  },
  {
    key: "exclude" as const,
    label: "Exclude Terms",
    placeholder: "jobs, salary, course",
  },
] as const;

const KEYWORD_RANGE_FILTERS = [
  { title: "Traffic", minKey: "minTraffic" as const, maxKey: "maxTraffic" as const },
  { title: "Volume", minKey: "minVol" as const, maxKey: "maxVol" as const },
  { title: "CPC (USD)", minKey: "minCpc" as const, maxKey: "maxCpc" as const, step: "0.01" },
  { title: "Score (KD)", minKey: "minKd" as const, maxKey: "maxKd" as const },
  { title: "Rank", minKey: "minRank" as const, maxKey: "maxRank" as const },
] as const;

type Props = {
  brandKey: string;
  target: string;
  hostname: string;
  scope: ResearchScope;
  routeState: DomainOverviewRouteState;
  tabs: ReactNode;
  liveMode: boolean;
  /** `keyword_research`: when off, the bulk-save action is hidden. */
  canSaveKeywords: boolean;
  /** False when the overview has no data: the bulk-save action is disabled. */
  hasData: boolean;
  /** The market chosen in the search card, which may not be the shown one. */
  formLocationCode: number;
  formLanguageCode: string;
  /** The shown market's country, for the disabled title. */
  marketCountry: string;
  /** The shown market's location code, sent with a save. */
  shownLocationCode: number;
  setSearchParams: (updates: SearchUpdate) => void;
  onSortClick: (sort: DomainSortMode) => void;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextSize: number) => void;
};

export function KeywordsTab({
  brandKey,
  target,
  hostname,
  scope,
  routeState,
  tabs,
  liveMode,
  canSaveKeywords,
  hasData,
  formLocationCode,
  formLanguageCode,
  marketCountry,
  shownLocationCode,
  setSearchParams,
  onSortClick,
  onPageChange,
  onPageSizeChange,
}: Props) {
  const [showFilters, setShowFilters] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(
    () => new Set(),
  );
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
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

  const scopeSlots = RESEARCH_SCOPE_FILTER_SLOTS.keywords[scope] ?? 0;
  const maxConditions = Math.max(0, MAX_DATAFORSEO_FILTER_CONDITIONS - scopeSlots);

  const {
    keywordFilters: savedFilters,
    saveKeywordFilters,
    clearKeywordFilters,
  } = useDomainFilterPreferences(brandKey, target);

  // Restore saved filters when URL has none
  useEffect(() => {
    if (!target) return;
    if (routeState.hasAppliedKeywordFilters) {
      setOverBudgetLimit(null);
      return;
    }

    const savedCount = countKeywordFilterConditions(savedFilters);
    if (savedCount === 0) {
      setOverBudgetLimit(null);
      return;
    }

    if (savedCount > maxConditions) {
      setOverBudgetLimit(maxConditions);
      return;
    }

    setOverBudgetLimit(null);
    setSearchParams(buildKeywordsSearchUpdate(savedFilters));
  }, [
    maxConditions,
    routeState.hasAppliedKeywordFilters,
    savedFilters,
    setSearchParams,
    target,
  ]);

  const activeFilterCount = useMemo(
    () => countKeywordFilterConditions(routeState.appliedFilters),
    [routeState.appliedFilters],
  );

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
    cacheOnly: !liveMode,
    maxUsd,
    enabled: Boolean(routeState.domain),
  });

  const rows = keywordsQuery.data?.keywords ?? [];
  const totalCount = keywordsQuery.data?.totalCount ?? null;
  const priceChanged = domainPriceChangeFromError(keywordsQuery.error);
  const queryError = keywordsQuery.isError
    ? priceChanged ? (
        <DomainPriceChangeReview
          label="Review new price"
          pendingLabel="Loading page..."
          brandKey={brandKey}
          action="domain.keywords.page"
          input={{
            domain: routeState.domain,
            scope: routeState.scope,
            locationCode: routeState.locationCode,
            pageSize: routeState.pageSize,
          }}
          pending={keywordsQuery.isFetching}
          onRun={(approvedMaxUsd) => {
            setPriceApproval({
              context: priceApprovalContext,
              maxUsd: approvedMaxUsd,
            });
          }}
          dialogTitle="Review keyword page price"
          confirmLabel="Load page"
          priceChanged={priceChanged}
        />
      ) : (
        <QueryError
          error={keywordsQuery.error}
          fallback="Lookup failed."
          onRetry={() => void keywordsQuery.refetch()}
          isRetrying={keywordsQuery.isFetching}
        />
      )
    : null;

  const handleToggleKeyword = useCallback((keyword: string) => {
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) next.delete(keyword);
      else next.add(keyword);
      return next;
    });
  }, []);

  const handleApplyFilters = useCallback(
    (values: KeywordsFilterValues) => {
      saveKeywordFilters(values);
      setOverBudgetLimit(null);
      setSearchParams(buildKeywordsSearchUpdate(values));
    },
    [saveKeywordFilters, setSearchParams],
  );

  const handleClearFilters = useCallback(() => {
    clearKeywordFilters();
    setOverBudgetLimit(null);
    const cleared: KeywordsFilterValues = {
      include: "",
      exclude: "",
      minTraffic: "",
      maxTraffic: "",
      minVol: "",
      maxVol: "",
      minCpc: "",
      maxCpc: "",
      minKd: "",
      maxKd: "",
      minRank: "",
      maxRank: "",
    };
    setSearchParams(buildKeywordsSearchUpdate(cleared));
  }, [clearKeywordFilters, setSearchParams]);

  const handleExport = useCallback(
    (format: ExportFormat) => {
      const table = keywordsToTable(rows);
      void runExport({
        format,
        feature: "domain_overview",
        headers: table.headers,
        rows: table.rows,
        filename: `${hostname || "domain"}-keywords`,
      });
    },
    [hostname, rows, runExport],
  );

  const selectedList = useMemo(
    () => [...selectedKeywords],
    [selectedKeywords],
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedKeywords.has(row.keyword)),
    [rows, selectedKeywords],
  );

  // Saving is refused when the form's market no longer matches the shown one,
  // or when there is nothing to save for the shown market.
  const saveDisabled = formLocationCode !== shownLocationCode || !hasData;
  const saveDisabledTitle = `Change the location back to ${marketCountry} or run the lookup again to save.`;

  const handleCopyKeywords = useCallback(async () => {
    const keywords = [...selectedKeywords];
    if (keywords.length === 0) return;
    try {
      if (
        typeof navigator === "undefined" ||
        !navigator.clipboard?.writeText
      ) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(keywords.join("\n"));
      toast.success(`${keywords.length} keywords copied`);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }, [selectedKeywords]);

  const handleBulkExport = useCallback(
    (format: ExportFormat) => {
      const table = keywordsToTable(selectedRows);
      void runExport({
        format,
        feature: "domain_overview",
        headers: table.headers,
        rows: table.rows,
        filename: `${hostname || "domain"}-keywords`,
        scope: "selection",
      });
    },
    [hostname, runExport, selectedRows],
  );

  const bulkBar = (
    <TableBulkActionBar
      selectedCount={selectedKeywords.size}
      selectedLabel="selected"
      onClear={() => setSelectedKeywords(new Set())}
      actions={
        <>
          {canSaveKeywords ? (
            <span title={saveDisabled ? saveDisabledTitle : undefined}>
              <TableBulkActionButton
                icon={<Save data-icon="inline-start" />}
                onClick={() => setSaveDialogOpen(true)}
                disabled={saveDisabled}
              >
                Save keywords
              </TableBulkActionButton>
            </span>
          ) : null}
          <TableBulkActionButton
            icon={<Copy data-icon="inline-start" />}
            onClick={() => void handleCopyKeywords()}
          >
            Copy keywords
          </TableBulkActionButton>
          <TableBulkExportMenu
            actions={[
              {
                label: "Export to Sheets",
                icon: <Sheet data-icon="inline-start" />,
                onClick: () => handleBulkExport("sheets"),
              },
              {
                label: "Export CSV",
                icon: <FileDown data-icon="inline-start" />,
                onClick: () => handleBulkExport("csv"),
              },
            ]}
          />
        </>
      }
    />
  );

  const filterPanel = (
    <DomainFilterPanel
      activeFilterCount={activeFilterCount}
      appliedFilters={routeState.appliedFilters}
      fields={KEYWORD_FILTER_FIELDS}
      textFields={KEYWORD_TEXT_FILTERS}
      rangeFields={KEYWORD_RANGE_FILTERS}
      countConditions={countKeywordFilterConditions}
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
        countLabel="keywords"
        totalCount={totalCount}
        fallbackCount={rows.length}
        onExport={handleExport}
        filterPanel={filterPanel}
        costHint="Each new page, sort or filter costs up to $0.02. Pages are reused for 12 hours."
      >
        <span className="text-sm text-muted-foreground">
          {selectedKeywords.size > 0
            ? `· ${selectedKeywords.size} selected`
            : "· Select keywords to save"}
        </span>
      </DomainTableToolbar>

      {bulkBar}

      {queryError ? <div className="px-4 py-3">{queryError}</div> : null}

      {(!keywordsQuery.isError || keywordsQuery.data) ? <DomainKeywordsTable
        domain={hostname}
        rows={rows}
        selectedKeywords={selectedKeywords}
        visibleKeywords={rows.map((r) => r.keyword)}
        sortMode={routeState.sort}
        currentSortOrder={routeState.order}
        isFiltered={activeFilterCount > 0}
        onClearFilters={handleClearFilters}
        onSortClick={onSortClick}
        onToggleKeyword={handleToggleKeyword}
      /> : null}

      {(!keywordsQuery.isError || keywordsQuery.data) ? <div className="border-t border-border px-4 py-3">
        <TablePagination
          page={routeState.page}
          pageSize={routeState.pageSize}
          pageSizes={DOMAIN_PAGE_SIZES}
          totalCount={totalCount}
          hasNextPage={keywordsQuery.data?.hasMore ?? false}
          isLoading={keywordsQuery.isFetching}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          renderPageButton={DomainPageLink}
        />
      </div> : null}

      {saveDialogOpen ? (
        <SaveDomainKeywordsDialog
          brandKey={brandKey}
          keywords={selectedList}
          locationCode={shownLocationCode}
          languageCode={formLanguageCode}
          onClose={() => setSaveDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
