// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingDomainList.tsx:55-328
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { toast } from "sonner";
import { AlertTriangle, Archive, ChevronRight, Globe, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { EmptyState } from "@/components/app/EmptyState";
import { QueryError } from "@/components/app/QueryState";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { useDebouncedDraft } from "@/components/app/hooks/useDebouncedDraft";
import {
  devicesLabel,
  rankScheduleLabel,
  rankSkipReasonMessage,
} from "@/shared/rank-tracking";
import {
  LOCATION_OPTIONS,
  SERP_LANGUAGE_OPTIONS,
  formatLocationLabel,
} from "@/shared/keyword-locations";
import { formatNextRun } from "@/shared/schedule";
import {
  EMPTY_DOMAIN_LIST_FILTERS,
  applyDomainListFilters,
  countActiveDomainListFilters,
  getDomainListFilterOptions,
  type DomainListFilters,
} from "@/shared/rank-tracking-filters";
import {
  useArchiveRankTracker,
  useRankTrackers,
  type RankTrackerSummary,
} from "./hooks/useRankTrackers";
import { DomainListFilterBar } from "./DomainListFilters";

const listSearchSchema = z.object({
  q: z.string(),
  device: z.string(),
  loc: z.string(),
});

const LIST_SEARCH_DEFAULTS = { q: "", device: "all", loc: "all" };

// Below this many domains the list is short enough to scan by eye, so the
// filter controls are more chrome than help. Still shown if filters are active
// (e.g. archiving dropped the count) so they never get orphaned.
const FILTER_BAR_MIN_DOMAINS = 6;

function countryLabel(locationCode: number): string {
  return (
    LOCATION_OPTIONS.find((option) => option.code === locationCode)?.label ??
    String(locationCode)
  );
}

export function RankTrackingDomainList({
  brandKey,
  onAddDomain,
}: {
  brandKey: string;
  onAddDomain: () => void;
}) {
  const [search, setSearch] = useUrlSearchState(
    listSearchSchema,
    LIST_SEARCH_DEFAULTS,
  );
  const [query, setQuery] = useDebouncedDraft(search.q ?? "", (q) =>
    setSearch({ q: q || undefined }),
  );
  const filters: DomainListFilters = {
    query,
    device:
      search.device === "all" ||
      search.device === "both" ||
      search.device === "desktop" ||
      search.device === "mobile"
        ? search.device
        : "all",
    locationCode: search.loc || "all",
  };
  const setFilters = (next: DomainListFilters) => {
    setQuery(next.query);
    if (
      next.device === filters.device &&
      next.locationCode === filters.locationCode
    ) {
      return;
    }
    // Carry the typed query too, so the navigation does not revert it.
    setSearch({
      q: next.query || undefined,
      device: next.device === "all" ? undefined : next.device,
      loc: next.locationCode === "all" ? undefined : next.locationCode,
    });
  };
  const clearFilters = () => {
    setQuery("");
    setSearch({ q: undefined, device: undefined, loc: undefined });
  };

  const summariesQuery = useRankTrackers(brandKey);
  const summaries = summariesQuery.data?.trackers;
  const allSummaries = useMemo(() => summaries ?? [], [summaries]);
  const filteredSummaries = applyDomainListFilters(allSummaries, filters);
  const filterOptions = useMemo(() => {
    const options = getDomainListFilterOptions(allSummaries);
    // A shared link can filter on a value no tracked domain has. Show it so
    // the select matches the URL.
    const { device, loc } = search;
    if (
      device &&
      device !== "all" &&
      !options.devices.some((o) => o.value === device)
    ) {
      options.devices.push({ value: device, label: devicesLabel(device as "both" | "desktop" | "mobile") });
    }
    if (
      loc &&
      loc !== "all" &&
      !options.locations.some((o) => o.value === loc)
    ) {
      options.locations.push({ value: loc, label: countryLabel(Number(loc)) });
    }
    return options;
  }, [allSummaries, search]);
  const activeFilterCount = countActiveDomainListFilters(filters);

  const [archiveTarget, setArchiveTarget] = useState<RankTrackerSummary | null>(
    null,
  );
  const archiveMutation = useArchiveRankTracker(brandKey);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-4 pb-3">
        <CardTitle>
          <h2 className="text-sm font-semibold">Tracked Domains</h2>
        </CardTitle>
        <CardAction className="self-center">
          <Button size="sm" onClick={onAddDomain}>
            <Plus data-icon="inline-start" />
            Add Domain
          </Button>
        </CardAction>
      </CardHeader>
      {(allSummaries.length >= FILTER_BAR_MIN_DOMAINS ||
        activeFilterCount > 0) && (
        <DomainListFilterBar
          filters={filters}
          options={filterOptions}
          onChange={setFilters}
          onReset={clearFilters}
        />
      )}
      <div className="divide-y divide-border border-t border-border">
        {summariesQuery.isError && (
          <div className="px-5 py-4">
            <QueryError
              error={summariesQuery.error}
              fallback="Failed to load tracked domains"
              onRetry={() => void summariesQuery.refetch()}
              isRetrying={summariesQuery.isFetching}
            />
          </div>
        )}
        {summariesQuery.isPending ? (
          <div className="space-y-4 px-5 py-4" aria-busy="true">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72" />
              </div>
            ))}
          </div>
        ) : !summaries ? null : summaries.length === 0 ? (
          <EmptyState
            variant="plain"
            icon={Globe}
            title="No tracked domains yet"
            description="Add a domain to start monitoring keyword rankings over time."
            action={
              <Button variant="outline" size="sm" onClick={onAddDomain}>
                Add Domain
              </Button>
            }
          />
        ) : filteredSummaries.length === 0 ? (
          <EmptyState
            variant="plain"
            kind="filtered"
            title="No matching tracked domains"
            description="Try clearing search or adjusting filters."
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          filteredSummaries.map((summary) => (
            <DomainRow
              key={summary.id}
              summary={summary}
              // Only needed to tell apart trackers that differ by language
              // alone; otherwise the language is just noise.
              showLanguage={allSummaries.some(
                (other) =>
                  other.domain === summary.domain &&
                  other.locationCode === summary.locationCode &&
                  other.languageCode !== summary.languageCode &&
                  (other.locationName ?? null) ===
                    (summary.locationName ?? null),
              )}
              onArchive={() => setArchiveTarget(summary)}
            />
          ))
        )}
      </div>

      {archiveTarget && (
        <ConfirmDialog
          title={`Archive ${archiveTarget.domain}?`}
          confirmLabel="Archive"
          destructive
          pending={archiveMutation.isPending}
          onConfirm={() =>
            archiveMutation.mutate(archiveTarget.id, {
              onSuccess: () => {
                setArchiveTarget(null);
                toast.success("Domain archived");
              },
            })
          }
          onClose={() => setArchiveTarget(null)}
        >
          Scheduled checks will stop and this domain will be hidden from the
          list. Ranking history is preserved.
        </ConfirmDialog>
      )}
    </Card>
  );
}

function DomainRow({
  summary,
  showLanguage,
  onArchive,
}: {
  summary: RankTrackerSummary;
  showLanguage: boolean;
  onArchive: () => void;
}) {
  const needsReview =
    summary.lastSkipReason === "price_changed" ||
    summary.lastSkipReason === "approval_missing";
  return (
    <div className="relative flex w-full items-center gap-4 px-5 py-3.5 transition-colors hover:bg-foreground/[0.03]">
      <Link
        href={`/portal/rank-tracking/${summary.id}`}
        className="absolute inset-0 z-0"
        aria-label={`Open ${summary.domain}`}
      />
      <div className="pointer-events-none min-w-0 flex-1">
        <p className="truncate font-medium">{summary.domain}</p>
        <p className="text-xs text-muted-foreground">
          {summary.locationName
            ? formatLocationLabel(summary.locationName, 2)
            : countryLabel(summary.locationCode)}{" "}
          {showLanguage && (
            <>
              &middot;{" "}
              {SERP_LANGUAGE_OPTIONS.find(
                (option) => option.code === summary.languageCode,
              )?.label ?? summary.languageCode}{" "}
            </>
          )}
          &middot; {devicesLabel(summary.devices)} &middot;{" "}
          {rankScheduleLabel(summary.scheduleInterval)}
          {summary.scheduleInterval !== "manual" && summary.nextCheckAt && (
            <> &middot; Next: {formatNextRun(summary.nextCheckAt)}</>
          )}
          {summary.lastRunCompletedAt && (
            <>
              {" "}
              &middot; Last:{" "}
              {new Date(summary.lastRunCompletedAt).toLocaleDateString()}
            </>
          )}
        </p>
        {summary.lastSkipReason && (
          <p
            className={`mt-1 flex items-center gap-1 text-xs ${needsReview ? "text-warning" : "text-muted-foreground"}`}
          >
            <AlertTriangle className="size-3" />
            {summary.lastSkipMessage ??
              rankSkipReasonMessage(summary.lastSkipReason)}
            {needsReview && (
              // Above the row link, like the archive button.
              <span className="pointer-events-auto relative z-10">
                <Link
                  href={`/portal/rank-tracking/${summary.id}`}
                  className="underline underline-offset-4 hover:no-underline"
                >
                  Review price
                </Link>
              </span>
            )}
          </p>
        )}
      </div>
      <div className="pointer-events-none hidden items-center gap-6 text-sm sm:flex">
        {summary.keywordCount > 0 && (
          <div className="text-center">
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              Keywords
            </p>
            <p className="font-mono font-medium">{summary.keywordCount}</p>
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        className="relative z-10 text-muted-foreground hover:text-destructive"
        title="Archive domain"
        aria-label={`Archive ${summary.domain}`}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onArchive();
        }}
      >
        <Archive className="size-4" />
      </Button>
      <ChevronRight className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
    </div>
  );
}
