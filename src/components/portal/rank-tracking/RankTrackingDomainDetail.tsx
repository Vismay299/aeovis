// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingDomainDetail.tsx:78-392
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useId, useMemo, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePortal } from "@/components/portal/PortalShell";
import { PageFrame } from "@/components/app/PageFrame";
import { QueryState } from "@/components/app/QueryState";
import { SkeletonCard, SkeletonPage } from "@/components/app/SkeletonPresets";
import { EmptyState } from "@/components/app/EmptyState";
import { NotFound } from "@/components/app/NotFound";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import {
  devicesCount,
  KEYWORDS_PER_BATCH,
  SECONDS_PER_BATCH,
  type ComparePeriod,
  type Devices,
  type RankSchedule,
  type RankTrackingRow,
} from "@/shared/rank-tracking";

export const comparePeriodSchema = z.enum(["1d", "7d", "30d", "90d"]);
import {
  applyFilters,
  countActiveFilters,
  EMPTY_FILTERS,
  type Filters,
} from "@/shared/rank-tracking-filters";
import { RankRunAlerts } from "./RankRunAlerts";
import { RankTrackingDetailHeader } from "./RankTrackingDetailHeader";
import { AddKeywordsPanel } from "./AddKeywordsPanel";
import { AiOverviewStrip } from "./AiOverviewStrip";
import { RankTrackingOverview } from "./RankTrackingOverview";
import { RankTrackingTableToolbar } from "./RankTrackingTableToolbar";
import { RankTrackingFilterPanel } from "./RankTrackingFilterPanel";
import { RankTrackingTable } from "./RankTrackingTable";
import {
  countMatrixRuns,
  RankTrackingHistoryMatrix,
  type RankPositionMatrixCell,
} from "./RankTrackingHistoryMatrix";
import { exportRankTracking } from "./RankTrackingTableParts";
import { RankTrackingConfigDialog } from "./RankTrackingConfigDialog";
import { useRankTracker } from "./hooks/useRankTrackers";
import { useRankResults } from "./hooks/useRankResults";
import { useRankRunPolling } from "./hooks/useRankRunPolling";
import { useRankCheckTrigger } from "./hooks/useRankCheckTrigger";
import { useMetricsRefresh } from "./hooks/useMetricsRefresh";

export const rankTrackingDetailSearchSchema = z.object({
  view: z.literal("history").optional().catch(undefined),
  device: z.enum(["desktop", "mobile"]).optional().catch(undefined),
  compare: comparePeriodSchema.optional().catch(undefined),
  sort: z
    .enum([
      "keyword",
      "desktopPosition",
      "mobilePosition",
      "volume",
      "kd",
      "cpc",
    ])
    .optional()
    .catch(undefined),
  order: z.enum(["asc", "desc"]).optional().catch(undefined),
  include: z.string().optional().catch(""),
  exclude: z.string().optional().catch(""),
  minDesktopPos: z.string().optional().catch(""),
  maxDesktopPos: z.string().optional().catch(""),
  minMobilePos: z.string().optional().catch(""),
  maxMobilePos: z.string().optional().catch(""),
  minVolume: z.string().optional().catch(""),
  maxVolume: z.string().optional().catch(""),
  minKd: z.string().optional().catch(""),
  maxKd: z.string().optional().catch(""),
  minCpc: z.string().optional().catch(""),
  maxCpc: z.string().optional().catch(""),
  aio: z.enum(["shown", "not_seen"]).optional().catch(undefined),
});

export type RankTrackingDetailSearch = z.infer<
  typeof rankTrackingDetailSearchSchema
>;

export const RANK_TRACKING_DETAIL_DEFAULTS: RankTrackingDetailSearch = {
  view: undefined,
  device: undefined,
  compare: undefined,
  sort: undefined,
  order: undefined,
  include: "",
  exclude: "",
  minDesktopPos: "",
  maxDesktopPos: "",
  minMobilePos: "",
  maxMobilePos: "",
  minVolume: "",
  maxVolume: "",
  minKd: "",
  maxKd: "",
  minCpc: "",
  maxCpc: "",
  aio: undefined,
};

function deviceVisibility(
  devices: Devices,
  activeDevice: "desktop" | "mobile",
): { showDesktop: boolean; showMobile: boolean } {
  if (devices === "both") {
    return {
      showDesktop: activeDevice === "desktop",
      showMobile: activeDevice === "mobile",
    };
  }
  return {
    showDesktop: devices !== "mobile",
    showMobile: devices !== "desktop",
  };
}

function defaultComparePeriod(interval: RankSchedule): ComparePeriod {
  if (interval === "daily") return "1d";
  if (interval === "monthly") return "30d";
  return "7d";
}

export function RankTrackingDomainDetail({ configId }: { configId: string }) {
  const { brandKey, brand, features } = usePortal();
  const queryClient = useQueryClient();

  const [search, setSearch] = useUrlSearchState<RankTrackingDetailSearch>(
    rankTrackingDetailSearchSchema,
    RANK_TRACKING_DETAIL_DEFAULTS,
  );

  const [showAddKeywords, setShowAddKeywords] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [checkDialogOpen, setCheckDialogOpen] = useState(false);
  const [reviewPriceOpen, setReviewPriceOpen] = useState(false);
  const [pendingCheckSelection, setPendingCheckSelection] = useState<string[] | null>(null);

  const configQuery = useRankTracker(brandKey ?? "", configId);
  const config = configQuery.data?.tracker ?? null;

  const comparePeriod =
    search.compare ?? (config ? defaultComparePeriod(config.scheduleInterval) : "7d");
  const activeDevice: "desktop" | "mobile" =
    config?.devices === "both" ? (search.device ?? "desktop") : (config?.devices === "desktop" ? "desktop" : "mobile");

  const resultsQuery = useRankResults(brandKey ?? "", configId, comparePeriod);
  const resultsData = resultsQuery.data;
  const rows = resultsData?.rows ?? [];
  const run = resultsData?.run ?? null;

  const latestRun = useRankRunPolling(brandKey ?? "", configId);
  const isRunning =
    (latestRun?.status === "pending" || latestRun?.status === "running") &&
    !latestRun?.maybeStale;

  const { startCheck, isBusy, isPending } = useRankCheckTrigger({
    brandKey: brandKey ?? "",
    configId,
    isRunning,
    onSuccess: () => {
      setCheckDialogOpen(false);
      setPendingCheckSelection(null);
    },
  });

  const { refresh: refreshMetrics, isRefreshing: metricsRefreshing } =
    useMetricsRefresh(brandKey ?? "", configId);

  // Matrix cells for history view and availability check
  const matrixQuery = useQuery({
    queryKey: keys.rankMatrix(brandKey ?? "", configId, activeDevice),
    queryFn: ({ signal }) =>
      fetchJson<{ cells: RankPositionMatrixCell[] }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/matrix?device=${encodeURIComponent(activeDevice)}&runLimit=12`,
          brandKey ?? "",
        ),
        { signal },
      ),
    enabled: Boolean(brandKey && configId),
  });
  const matrixCells = matrixQuery.data?.cells ?? [];
  const historyAvailable = countMatrixRuns(matrixCells) >= 2;
  const effectiveViewMode = historyAvailable && search.view === "history" ? "history" : "table";

  // Build filters from URL search state
  const filters: Filters = useMemo(
    () => ({
      include: search.include ?? "",
      exclude: search.exclude ?? "",
      minDesktopPos: search.minDesktopPos ?? "",
      maxDesktopPos: search.maxDesktopPos ?? "",
      minMobilePos: search.minMobilePos ?? "",
      maxMobilePos: search.maxMobilePos ?? "",
      minVolume: search.minVolume ?? "",
      maxVolume: search.maxVolume ?? "",
      minKd: search.minKd ?? "",
      maxKd: search.maxKd ?? "",
      minCpc: search.minCpc ?? "",
      maxCpc: search.maxCpc ?? "",
      aiOverview:
        search.aio === "shown"
          ? "shown"
          : search.aio === "not_seen"
            ? "not_seen"
            : "any",
    }),
    [search],
  );

  const activeFilterCount = countActiveFilters(filters);

  const { showDesktop, showMobile } = config
    ? deviceVisibility(config.devices, activeDevice)
    : { showDesktop: false, showMobile: true };

  const filteredRows = useMemo(
    () => applyFilters(rows, filters, activeDevice),
    [rows, filters, activeDevice],
  );

  // AI Overview counts from checked keywords on active device
  const { aioOverviewCount, aioCheckedCount } = useMemo(() => {
    let checked = 0;
    let overview = 0;
    for (const r of rows) {
      const devRes = r[activeDevice];
      if (devRes && devRes.checkedAt !== null) {
        checked++;
        if (devRes.serpFeatures.includes("ai_overview")) {
          overview++;
        }
      }
    }
    return { aioOverviewCount: overview, aioCheckedCount: checked };
  }, [rows, activeDevice]);

  // Price quote for Check rankings
  const targetCheckKeywords = pendingCheckSelection ?? (rows.length > 0 ? rows.map((r) => r.trackingKeywordId) : []);
  const checkQuote = usePriceQuote(
    {
      brandKey: brandKey ?? "",
      action: "rank_tracking.check.run",
      input: {
        configId,
        method: "live",
        keywordIds: pendingCheckSelection ?? undefined,
      },
    },
    { enabled: checkDialogOpen && Boolean(brandKey && configId) },
  );

  // Price review quote for skipped / price changed configs
  const reviewQuote = usePriceQuote(
    {
      brandKey: brandKey ?? "",
      action: "rank_tracking.config.save",
      input: {
        configId,
        scheduleInterval: config?.scheduleInterval,
        draft: {
          keywordCount: config?.keywordCount ?? rows.length,
          devices: config?.devices,
          serpDepth: config?.serpDepth,
        },
      },
    },
    { enabled: reviewPriceOpen && Boolean(brandKey && configId) },
  );

  if (features === null) return <SkeletonPage />;
  if (features?.rank_tracking !== true) return <NotFound />;
  if (!brandKey) {
    return (
      <EmptyState
        title="Workspace required"
        description="Select a workspace to use Rank Tracking."
      />
    );
  }

  if (configQuery.isPending) {
    return (
      <PageFrame className="min-w-0 max-w-full overflow-x-hidden space-y-3">
        <SkeletonCard />
      </PageFrame>
    );
  }

  if (configQuery.isError || !config) {
    return (
      <PageFrame className="min-w-0 max-w-full overflow-x-hidden space-y-3">
        <NotFound />
      </PageFrame>
    );
  }

  const defaultSortId = showDesktop ? "desktopPosition" : "mobilePosition";
  const sortId =
    (search.sort === "desktopPosition" && !showDesktop) ||
    (search.sort === "mobilePosition" && !showMobile)
      ? undefined
      : search.sort;

  const handleExport = (format: "csv" | "sheets" | "copy-list") => {
    if (format === "copy-list") {
      void navigator.clipboard.writeText(
        filteredRows.map((r) => r.keyword).join("\n"),
      );
      toast.success("Keywords copied to clipboard");
      return;
    }
    exportRankTracking({
      format,
      rows: filteredRows,
      showDesktop,
      showMobile,
      domain: config.domain,
      locationName: config.locationName,
    });
  };

  const handleCheckPrompt = (keywordIds?: string[]) => {
    setPendingCheckSelection(keywordIds ?? null);
    setCheckDialogOpen(true);
  };

  const checkCount = targetCheckKeywords.length || config.keywordCount || rows.length;
  const dc = devicesCount(config.devices);
  const totalChecks = checkCount * dc;
  const liveTime =
    Math.ceil(totalChecks / KEYWORDS_PER_BATCH) * SECONDS_PER_BATCH;
  const eta =
    liveTime < 60 ? `${liveTime}s` : `${Math.ceil(liveTime / 60)} min`;

  return (
    <PageFrame className="min-w-0 max-w-full overflow-x-hidden space-y-3">
      {/* Run Alerts */}
      <RankRunAlerts
        run={latestRun}
        tracker={config}
        onReviewPrice={() => setReviewPriceOpen(true)}
      />

      {/* Main card */}
      <div className="flex min-w-0 max-w-full flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Header */}
        <RankTrackingDetailHeader
          config={config}
          lastCheckedAt={run?.lastCheckedAt ?? config.lastCheckedAt}
          costUsd={config.approvedMaxUsd}
          activeDevice={activeDevice}
          onActiveDeviceChange={(dev) =>
            setSearch({ device: dev, sort: undefined, order: undefined })
          }
          comparePeriod={comparePeriod}
          onComparePeriodChange={(comp) => setSearch({ compare: comp })}
          onConfigure={() => setEditDialogOpen(true)}
          onAddKeywords={() => setShowAddKeywords((prev) => !prev)}
        />

        {/* Add keywords panel */}
        {showAddKeywords && (
          <div className="px-4 pb-3">
            <AddKeywordsPanel
              config={config}
              brandKey={brandKey}
              onCancel={() => setShowAddKeywords(false)}
              onSuccess={({ added }) => {
                setShowAddKeywords(false);
                void queryClient.invalidateQueries({
                  queryKey: keys.rankResults(brandKey, configId, comparePeriod),
                });
                void queryClient.invalidateQueries({
                  queryKey: keys.rankTracker(brandKey, configId),
                });
                toast.success(`${added} keyword${added !== 1 ? "s" : ""} added`);
                toast.info("Use 'Check rankings' to check these keywords");
              }}
            />
          </div>
        )}

        {/* AI Overview strip */}
        <AiOverviewStrip
          overviewCount={aioOverviewCount}
          checkedCount={aioCheckedCount}
          device={activeDevice}
          onShowThem={() => setSearch({ aio: "shown" })}
        />

        {/* Position distribution overview */}
        {rows.length > 0 && (
          <RankTrackingOverview
            brandKey={brandKey}
            configId={configId}
            device={activeDevice}
          />
        )}

        {/* Toolbar */}
        <RankTrackingTableToolbar
          showFilters={showFilters}
          onToggleFilters={() => setShowFilters((prev) => !prev)}
          activeFilterCount={activeFilterCount}
          isRunning={isRunning}
          latestRun={latestRun}
          keywordCount={filteredRows.length}
          viewMode={effectiveViewMode}
          onViewModeChange={(mode) =>
            setSearch({ view: mode === "history" ? "history" : undefined })
          }
          historyAvailable={historyAvailable}
          onExport={handleExport}
          onCheckRankings={() => handleCheckPrompt()}
          onRefreshMetrics={(opts) => refreshMetrics(opts)}
          metricsRefreshing={metricsRefreshing}
          trackedKeywordCount={config.keywordCount || rows.length}
          checkBusy={isBusy}
          hasData={filteredRows.length > 0}
        />

        {/* Filters panel */}
        {showFilters && (
          <RankTrackingFilterPanel
            draft={filters}
            setDraft={(next) => {
              setSearch({
                include: next.include || undefined,
                exclude: next.exclude || undefined,
                minDesktopPos: next.minDesktopPos || undefined,
                maxDesktopPos: next.maxDesktopPos || undefined,
                minMobilePos: next.minMobilePos || undefined,
                maxMobilePos: next.maxMobilePos || undefined,
                minVolume: next.minVolume || undefined,
                maxVolume: next.maxVolume || undefined,
                minKd: next.minKd || undefined,
                maxKd: next.maxKd || undefined,
                minCpc: next.minCpc || undefined,
                maxCpc: next.maxCpc || undefined,
                aio:
                  next.aiOverview === "shown"
                    ? "shown"
                    : next.aiOverview === "not_seen"
                      ? "not_seen"
                      : undefined,
              });
            }}
            activeFilterCount={activeFilterCount}
            onReset={() =>
              setSearch({
                include: undefined,
                exclude: undefined,
                minDesktopPos: undefined,
                maxDesktopPos: undefined,
                minMobilePos: undefined,
                maxMobilePos: undefined,
                minVolume: undefined,
                maxVolume: undefined,
                minKd: undefined,
                maxKd: undefined,
                minCpc: undefined,
                maxCpc: undefined,
                aio: undefined,
              })
            }
          />
        )}

        {/* Main table or history matrix */}
        <div className="p-4">
          {effectiveViewMode === "history" ? (
            <RankTrackingHistoryMatrix
              cells={matrixCells}
              keywords={filteredRows.map((r) => ({
                trackingKeywordId: r.trackingKeywordId,
                keyword: r.keyword,
              }))}
              onClearFilters={() =>
                setSearch({
                  include: undefined,
                  exclude: undefined,
                  minDesktopPos: undefined,
                  maxDesktopPos: undefined,
                  minMobilePos: undefined,
                  maxMobilePos: undefined,
                  minVolume: undefined,
                  maxVolume: undefined,
                  minKd: undefined,
                  maxKd: undefined,
                  minCpc: undefined,
                  maxCpc: undefined,
                  aio: undefined,
                })
              }
            />
          ) : (
            <QueryState
              query={resultsQuery}
              errorFallback="Failed to load rank data"
              loading={<SkeletonCard />}
            >
              {() => (
                <RankTrackingTable
                  key={defaultSortId}
                  totalCount={rows.length}
                  rows={filteredRows}
                  showDesktop={showDesktop}
                  showMobile={showMobile}
                  sorting={
                    sortId
                      ? [{ id: sortId, desc: search.order === "desc" }]
                      : [{ id: defaultSortId, desc: false }]
                  }
                  onSortingChange={(sorting) => {
                    const top = sorting[0];
                    setSearch({
                      sort: top?.id as any,
                      order: top?.desc ? "desc" : undefined,
                    });
                  }}
                  domain={config.domain}
                  configId={config.id}
                  brandKey={brandKey}
                  locationCode={config.locationCode}
                  languageCode={config.languageCode}
                  locationName={config.locationName}
                  serpDepth={config.serpDepth}
                  onAddKeywords={() => setShowAddKeywords(true)}
                  onClearFilters={() =>
                    setSearch({
                      include: undefined,
                      exclude: undefined,
                      minDesktopPos: undefined,
                      maxDesktopPos: undefined,
                      minMobilePos: undefined,
                      maxMobilePos: undefined,
                      minVolume: undefined,
                      maxVolume: undefined,
                      minKd: undefined,
                      maxKd: undefined,
                      minCpc: undefined,
                      maxCpc: undefined,
                      aio: undefined,
                    })
                  }
                  onCheckSelected={(keywordIds) => handleCheckPrompt(keywordIds)}
                />
              )}
            </QueryState>
          )}
        </div>
      </div>

      {/* Check rankings cost dialog */}
      <CostReviewDialog
        open={checkDialogOpen}
        title={`Check ${checkCount} keyword${checkCount !== 1 ? "s" : ""} now?`}
        confirmLabel="Run check"
        pendingLabel="Starting check…"
        quote={checkQuote}
        pending={isPending}
        priceChanged={null}
        error={null}
        onConfirm={(maxUsd) => {
          startCheck({
            keywordIds: pendingCheckSelection ?? undefined,
            maxUsd,
            totalKeywords: checkCount,
          });
        }}
        onClose={() => {
          setCheckDialogOpen(false);
          setPendingCheckSelection(null);
        }}
        detail={() => (
          <p className="text-sm text-muted-foreground">
            {checkCount} keywords × {dc} device{dc !== 1 ? "s" : ""} = {totalChecks} searches. Results in about {eta}.
          </p>
        )}
      />

      {/* Review price dialog for scheduled check skips */}
      <CostReviewDialog
        open={reviewPriceOpen}
        title="Approve scheduled checks"
        confirmLabel="Approve and save"
        pendingLabel="Saving…"
        quote={reviewQuote}
        pending={false}
        priceChanged={null}
        error={null}
        onConfirm={async (maxUsd) => {
          try {
            await fetchJson(
              withBrand(
                `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}`,
                brandKey,
              ),
              {
                method: "PATCH",
                body: { brand_key: brandKey, maxUsd },
              },
            );
            void queryClient.invalidateQueries({
              queryKey: keys.rankTracker(brandKey, configId),
            });
            setReviewPriceOpen(false);
            toast.success("Schedule price approved");
          } catch (err: any) {
            toast.error(err?.message || "Failed to approve price.");
          }
        }}
        onClose={() => setReviewPriceOpen(false)}
      />

      {/* Edit config dialog */}
      {editDialogOpen && (
        <RankTrackingConfigDialog
          brandKey={brandKey}
          website={brand?.website ?? null}
          existingConfig={config}
          onClose={() => setEditDialogOpen(false)}
          onSaved={() => {
            setEditDialogOpen(false);
            void queryClient.invalidateQueries({
              queryKey: keys.rankTracker(brandKey, configId),
            });
          }}
        />
      )}
    </PageFrame>
  );
}
