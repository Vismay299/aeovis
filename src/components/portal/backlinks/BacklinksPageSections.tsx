"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksPageSections.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useMemo } from "react";
import { AlertTriangle, List, Rows3 } from "lucide-react";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DataTableTabs,
  DataTableToolbar,
  DataTableFilterToggle,
} from "@/components/app/table/DataTableToolbar";
import { type DataTableFrameProps } from "@/components/app/table/DataTable";
import { TablePagination } from "@/components/app/table/TablePagination";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import { ExportMenu } from "@/components/app/ExportMenu";
import { QueryError } from "@/components/app/QueryState";
import { useExportRows } from "@/components/app/export/useExportRows";
import {
  BACKLINKS_PAGE_SIZES,
  TAB_DESCRIPTIONS,
  backlinksFilterConditionLimit,
  buildBacklinksTabExport,
  buildBacklinksTabFilename,
  type BacklinksRow,
  type BacklinksTab,
  type BacklinksTargetScope,
  type ReferringDomainRow,
  type TopPageRow,
} from "@/shared/backlinks";
import { BacklinksTable } from "./BacklinksTable";
import { ReferringDomainsTable } from "./ReferringDomainsTable";
import { TopPagesTable } from "./TopPagesTable";
import { BacklinksFilterPanel } from "./BacklinksFilterPanel";
import { BacklinksBestLinksMenu } from "./BacklinksToolbarMenus";
import type { BacklinksDomainExpansion } from "./hooks/useBacklinksDomainExpansion";
import type { BacklinksFiltersState } from "./hooks/useBacklinksFilters";
import { formatUsd } from "@/shared/pricing";

const BACKLINKS_RESULTS_TABS: { tab: BacklinksTab; label: string }[] = [
  { tab: "backlinks", label: "Backlinks" },
  { tab: "domains", label: "Referring Domains" },
  { tab: "pages", label: "Top Pages" },
];

function formatPageEstimate(totalUsd: number): string {
  return formatUsd(Math.ceil(totalUsd * 100) / 100);
}

export function BacklinksResultsCard({
  brandKey,
  activeTab,
  scope,
  tabRows,
  filters,
  sorting,
  view,
  hideSpam,
  onHideSpamChange,
  domainExpansion,
  isTabLoading,
  showTable,
  tabErrorMessage,
  tabError,
  onRetryTab,
  isTabRetrying,
  exportTarget,
  pagination,
  onPageChange,
  onPageSizeChange,
  onSortingChange,
  onTabChange,
  onViewChange,
}: {
  brandKey: string;
  activeTab: BacklinksTab;
  scope: BacklinksTargetScope;
  tabRows: {
    backlinks: BacklinksRow[];
    referringDomains: ReferringDomainRow[];
    topPages: TopPageRow[];
  };
  filters: BacklinksFiltersState;
  sorting: SortingState;
  view: "all" | undefined;
  hideSpam: boolean;
  onHideSpamChange: (hideSpam: boolean) => void;
  domainExpansion: BacklinksDomainExpansion;
  isTabLoading: boolean;
  showTable: boolean;
  tabErrorMessage: string | null;
  tabError?: unknown;
  onRetryTab?: () => void;
  isTabRetrying: boolean;
  exportTarget: string;
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number | null;
    hasNextPage: boolean;
    isFetching: boolean;
  };
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextPageSize: number) => void;
  onSortingChange: OnChangeFn<SortingState>;
  onTabChange: (tab: BacklinksTab) => void;
  onViewChange: (view: "all" | undefined) => void;
}) {
  const exportRowsHandler = useExportRows();
  const activeFilterCount = filters[activeTab].activeFilterCount;
  const pageQuote = usePriceQuote({
    brandKey,
    action: "backlinks.page",
    input: { tab: activeTab, pageSize: pagination.pageSize },
  });
  const exportTable = useMemo(
    () =>
      buildBacklinksTabExport({
        tab: activeTab,
        rows: tabRows,
      }),
    [activeTab, tabRows],
  );

  const filterState = filters[activeTab];

  const frame: DataTableFrameProps = {
    isLoading: isTabLoading,
    isFiltered: activeFilterCount > 0,
    onClearFilters: () => {
      filterState.reset();
      onPageChange(1);
    },
    error: tabErrorMessage ? (
      <QueryError
        cause={tabError}
        fallback={tabErrorMessage}
        onRetry={onRetryTab}
        isRetrying={isTabRetrying}
      />
    ) : null,
    toolbar: (
      <>
        <DataTableTabs
          value={activeTab}
          onValueChange={(value) => {
            const next = BACKLINKS_RESULTS_TABS.find(
              (item) => item.tab === value,
            );
            if (next) onTabChange(next.tab);
          }}
          description={TAB_DESCRIPTIONS[activeTab]}
        >
          {BACKLINKS_RESULTS_TABS.map(({ label, tab }) => (
            <TabsTrigger key={tab} value={tab}>
              {label}
            </TabsTrigger>
          ))}
        </DataTableTabs>
        <DataTableToolbar
          actions={
            <ExportMenu
              actions={["sheets", "csv"]}
              scopes={[{ id: "page", label: "Current page · selected view" }]}
              disabled={exportTable.rows.length === 0}
              onExport={(format) =>
                void exportRowsHandler({
                  format,
                  feature: `backlinks_${activeTab}`,
                  ...exportTable,
                  filename: buildBacklinksTabFilename(
                    activeTab,
                    exportTarget,
                  ),
                })
              }
            />
          }
        >
          <DataTableFilterToggle
            open={filters.showFilters}
            activeCount={activeFilterCount}
            onToggle={() => filters.setShowFilters((current) => !current)}
          />
          {activeTab === "backlinks" ? (
            <>
              <BacklinksBestLinksMenu
                hideSpam={hideSpam}
                onHideSpamChange={onHideSpamChange}
              />
              <SegmentedToggle
                showLabels
                value={view ?? "one"}
                onChange={(next) =>
                  onViewChange(next === "all" ? "all" : undefined)
                }
                items={[
                  {
                    value: "one",
                    icon: <Rows3 />,
                    label: "One per domain",
                  },
                  { value: "all", icon: <List />, label: "All links" },
                ]}
              />
            </>
          ) : null}
        </DataTableToolbar>
        <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border/50">
          Each new page, sort or filter costs up to {pageQuote.data ? formatPageEstimate(pageQuote.data.totalUsd) : "…"}. Results are reused for 6 hours.
        </div>
        {filters.showFilters ? (
          <BacklinksFilterPanel
            activeTab={activeTab}
            filters={filters}
            onApplied={() => onPageChange(1)}
            maxConditions={backlinksFilterConditionLimit(
              scope,
              activeTab === "backlinks" && hideSpam,
            )}
          />
        ) : null}
      </>
    ),
    footer: (
      <TablePagination
        page={pagination.page}
        pageSize={pagination.pageSize}
        pageSizes={BACKLINKS_PAGE_SIZES}
        totalCount={pagination.totalCount}
        hasNextPage={pagination.hasNextPage}
        isLoading={pagination.isFetching}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    ),
  };

  // Subfolder scope on referring domains tab: show note Alert instead of table
  if (scope === "subfolder" && activeTab === "domains") {
    return (
      <div className="space-y-3">
        {frame.toolbar}
        <div className="p-4">
          <Alert variant="info">
            <AlertTriangle />
            <AlertDescription className="text-foreground">
              Showing backlinks pointing into this subfolder. Counts come from filtered backlink totals; rank, trends, and the referring-domains breakdown need Domain or Subdomains scope.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <>
      {tabErrorMessage && !showTable ? (
        <div className="space-y-3">
          {frame.toolbar}
          <div className="p-4">
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription className="text-foreground">
                {tabErrorMessage}
              </AlertDescription>
            </Alert>
          </div>
        </div>
      ) : (
        <>
          {activeTab === "backlinks" ? (
            <BacklinksTable
              rows={showTable ? tabRows.backlinks : []}
              sorting={sorting}
              onSortingChange={onSortingChange}
              expansion={view === "all" ? null : domainExpansion}
              {...frame}
            />
          ) : null}
          {activeTab === "domains" ? (
            <ReferringDomainsTable
              rows={showTable ? tabRows.referringDomains : []}
              sorting={sorting}
              onSortingChange={onSortingChange}
              {...frame}
            />
          ) : null}
          {activeTab === "pages" ? (
            <TopPagesTable
              rows={showTable ? tabRows.topPages : []}
              sorting={sorting}
              onSortingChange={onSortingChange}
              {...frame}
            />
          ) : null}
        </>
      )}
    </>
  );
}
