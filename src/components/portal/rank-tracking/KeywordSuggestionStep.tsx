// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/KeywordSuggestionStep.tsx:144-342
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { MonthlyProjection } from "@/components/app/cost/MonthlyProjection";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { Spinner } from "@/components/app/Spinner";
import {
  DataTable,
  makeSelectionColumn,
  useDataTable,
  useSelectionAnchor,
} from "@/components/app/table/DataTable";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import { applyShiftRangeSelection } from "@/lib/table/tableSelection";
import { fetchJson, isApiError } from "@/lib/query/fetchJson";
import { isLabsLocationCode } from "@/shared/keyword-locations";
import {
  devicesLabel,
  type Devices,
  type RankSchedule,
} from "@/shared/rank-tracking";
import type { PriceQuote } from "@/shared/pricing";
import { trackRankEvent } from "./telemetry";

export type SuggestedKeyword = {
  keyword: string;
  position: number | null;
  searchVolume: number | null;
  traffic: number | null;
  cpc: number | null;
  keywordDifficulty: number | null;
};

const PRE_SELECT_COUNT = 20;

function unknown(value: number | null, round = false): string {
  if (value == null) return "—";
  const shown = round ? Math.round(value) : value;
  return shown.toLocaleString();
}

const baseColumns: ColumnDef<SuggestedKeyword>[] = [
  {
    id: "keyword",
    accessorKey: "keyword",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Keyword"
        title="The search term this domain ranks for"
      />
    ),
    cell: ({ getValue }) => (
      <span className="font-medium">{getValue<string>()}</span>
    ),
    sortingFn: "alphanumeric",
  },
  {
    id: "position",
    accessorKey: "position",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Position"
        title="Current Google ranking position"
        align="right"
      />
    ),
    cell: ({ getValue }) => {
      const pos = getValue<number | null>();
      return pos != null ? (
        <span className="text-right tabular-nums">{pos}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.position ?? 999;
      const b = rowB.original.position ?? 999;
      return a - b;
    },
  },
  {
    id: "searchVolume",
    accessorKey: "searchVolume",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Volume"
        title="Monthly search volume"
        align="right"
      />
    ),
    cell: ({ getValue }) => {
      const vol = getValue<number | null>();
      return vol != null ? (
        <span className="tabular-nums">{unknown(vol)}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.searchVolume ?? 0;
      const b = rowB.original.searchVolume ?? 0;
      return a - b;
    },
  },
  {
    id: "traffic",
    accessorKey: "traffic",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Traffic"
        title="Estimated monthly organic traffic"
        align="right"
      />
    ),
    cell: ({ getValue }) => {
      const traffic = getValue<number | null>();
      return traffic != null ? (
        <span className="tabular-nums">{unknown(traffic, true)}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.traffic ?? 0;
      const b = rowB.original.traffic ?? 0;
      return a - b;
    },
  },
];

type SuggestionsResponse = {
  keywords: SuggestedKeyword[] | null;
  cached?: boolean;
  fetchedAt?: string;
};

type AddKeywordsResponse = {
  added: number;
  addedIds: string[];
  skipped: number;
  metricsFromCache: number;
  approval: { approvedMaxUsd: number; quote: PriceQuote } | null;
};

export function KeywordSuggestionStep({
  brandKey,
  configId,
  domain,
  locationCode,
  devices,
  scheduleInterval,
  approvedMaxUsd,
  onSaved,
  onClose,
}: {
  brandKey: string;
  configId: string;
  domain: string;
  locationCode: number;
  devices: Devices;
  scheduleInterval: RankSchedule;
  approvedMaxUsd: number | null;
  onSaved: (added: number) => void;
  onClose: () => void;
}) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [hasInitialized, setHasInitialized] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "traffic", desc: true },
  ]);
  const selectAnchorRef = useSelectionAnchor();

  // cacheOnly first: opening the step never spends.
  const [lookup, setLookup] = useState<
    | { status: "loading" }
    | { status: "ready"; keywords: SuggestedKeyword[]; cached: boolean }
    | { status: "error" }
  >({ status: "loading" });
  const [finding, setFinding] = useState(false);
  const [searched, setSearched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [approval, setApproval] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);

  const columns = useMemo<ColumnDef<SuggestedKeyword>[]>(
    () => [makeSelectionColumn<SuggestedKeyword>(selectAnchorRef), ...baseColumns],
    // The selection column anchors to row identity for the life of the step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const labsSupported = isLabsLocationCode(locationCode);

  async function fetchSuggestions(cacheOnly: boolean, maxUsd?: number) {
    return fetchJson<SuggestionsResponse>(
      "/api/customer/rank-tracking/suggestions",
      {
        method: "POST",
        body: {
          brand_key: brandKey,
          domain,
          locationCode,
          cacheOnly,
          ...(maxUsd !== undefined ? { maxUsd } : {}),
          requestId: crypto.randomUUID(),
        },
      },
    );
  }

  useEffect(() => {
    if (!labsSupported) return;
    let cancelled = false;
    fetchSuggestions(true)
      .then((body) => {
        if (cancelled) return;
        if (body.keywords == null) {
          setLookup({ status: "ready", keywords: [], cached: false });
        } else {
          setLookup({ status: "ready", keywords: body.keywords, cached: true });
          trackRankEvent("rank_tracking:suggestions_open", {
            cached: true,
            count: body.keywords.length,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setLookup({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // One cacheOnly read per step mount; the paid fetch is click-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labsSupported]);

  const data = useMemo(
    () => (lookup.status === "ready" ? lookup.keywords : []),
    [lookup],
  );
  const showCachedHeader =
    lookup.status === "ready" && lookup.cached && data.length > 0;

  // Pre-select top 20 by traffic once data loads.
  useEffect(() => {
    if (lookup.status !== "ready" || data.length === 0 || hasInitialized) return;
    const indexed = data.map((item, index) => ({
      index,
      traffic: item.traffic ?? 0,
    }));
    indexed.sort((a, b) => b.traffic - a.traffic);
    const initial: RowSelectionState = {};
    for (let i = 0; i < Math.min(PRE_SELECT_COUNT, indexed.length); i++) {
      initial[indexed[i].index] = true;
    }
    setRowSelection(initial);
    setHasInitialized(true);
  }, [lookup, data, hasInitialized]);

  const table = useDataTable({
    data,
    columns,
    state: { rowSelection, sorting },
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    withSorting: true,
    enableRowSelection: true,
  });

  const selectedCount = Object.keys(rowSelection).filter(
    (key) => rowSelection[key],
  ).length;

  async function handleFind(maxUsd: number) {
    setFinding(true);
    try {
      const body = await fetchSuggestions(false, maxUsd);
      setSearched(true);
      setLookup({
        status: "ready",
        keywords: body.keywords ?? [],
        cached: body.cached ?? false,
      });
      trackRankEvent("rank_tracking:suggestions_open", {
        cached: false,
        count: body.keywords?.length ?? 0,
      });
    } catch {
      setLookup({ status: "error" });
    } finally {
      setFinding(false);
    }
  }

  async function handleSave(maxUsd?: number) {
    const selectedKeywords = table
      .getSelectedRowModel()
      .rows.map((row) => row.original.keyword);
    if (selectedKeywords.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await fetchJson<AddKeywordsResponse>(
        `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/keywords`,
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            keywords: selectedKeywords,
            matchCase: false,
            source: "suggestions",
            ...(maxUsd !== undefined ? { maxUsd } : {}),
          },
        },
      );
      setApproval(null);
      toast.success(`Added ${result.added} keywords for tracking`);
      trackRankEvent("rank_tracking:keywords_add", {
        count: result.added,
        source: "suggestions",
      });
      onSaved(result.added);
    } catch (err) {
      if (isApiError(err) && (err.code === "approval_required" || err.code === "price_changed")) {
        const details = (err.details ?? {}) as {
          quote?: PriceQuote;
          approvedMaxUsd?: number;
        };
        if (details.quote) {
          setApproval({
            approvedMaxUsd: details.approvedMaxUsd ?? approvedMaxUsd ?? 0,
            quote: details.quote,
          });
        } else {
          setSaveError(err.message);
        }
      } else {
        setSaveError(
          err instanceof Error
            ? err.message
            : "The keywords could not be saved. Please retry.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const selectedForDetail = table
    .getSelectedRowModel()
    .rows.map((row) => row.original.keyword);

  if (!labsSupported) {
    return (
      <>
        <StepHeader
          title="Add keywords manually"
          description="Ranked-keyword suggestions aren't available for this country. Continue and add the keywords you want to track manually."
        />
        <DialogFooter>
          <Button onClick={onClose}>Continue</Button>
        </DialogFooter>
      </>
    );
  }

  if (lookup.status === "loading" || finding) {
    return (
      <>
        <StepHeader title="Finding your top keywords…" />
        <div className="flex flex-col items-center justify-center py-16">
          <Spinner label="This usually takes a few seconds" />
        </div>
      </>
    );
  }

  if (lookup.status === "error") {
    return (
      <>
        <StepHeader
          title="Couldn't fetch keywords"
          description="You can skip this step and add keywords manually later."
        />
        <DialogFooter>
          <Button onClick={onClose}>Skip</Button>
        </DialogFooter>
      </>
    );
  }

  if (data.length === 0 && !showCachedHeader) {
    // No cache entry yet and no paid fetch: invite the priced fetch.
    if (!searched) {
      return (
        <>
          <StepHeader
            title={`Find the keywords ${domain} already ranks for`}
          />
          <div className="flex flex-col items-start gap-2">
            <PricedActionButton
              label="Find ranking keywords"
              pendingLabel="Finding keywords…"
              brandKey={brandKey}
              action="rank_tracking.suggestions.run"
              input={{ domain, locationCode }}
              pending={finding}
              onRun={(maxUsd) => void handleFind(maxUsd)}
              dialogTitle="Find ranking keywords"
              confirmLabel="Find keywords"
            />
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              onClick={onClose}
            >
              Add keywords manually instead
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <StepHeader
          title="No rankings found"
          description={`We couldn't find any keywords ${domain} currently ranks for. You can add keywords manually.`}
        />
        <DialogFooter>
          <Button onClick={onClose}>Skip</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <StepHeader
        title={
          showCachedHeader
            ? `Found ${data.length} keywords ${domain} ranks for.`
            : "Choose keywords to track"
        }
        description={
          showCachedHeader
            ? undefined
            : `We found ${data.length} keywords ${domain} ranks for.`
        }
      />

      <DataTable
        table={table}
        empty={{ title: "No keywords" }}
        scrollClassName="max-h-[400px]"
        onRowClick={(row, event) => {
          if (applyShiftRangeSelection(event, row, table, selectAnchorRef)) {
            return;
          }
          row.toggleSelected();
        }}
      />

      {saveError ? (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter className="items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {selectedCount} of {data.length} selected
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Skip
          </Button>
          <Button
            onClick={() => void handleSave()}
            pending={saving}
            disabled={selectedCount === 0}
          >
            Save Keyword{selectedCount !== 1 ? "s" : ""}
          </Button>
        </div>
      </DialogFooter>

      <CostReviewDialog
        open={approval !== null}
        title="Approve scheduled checks"
        confirmLabel="Approve and save"
        pendingLabel="Saving…"
        quote={{
          data: approval?.quote,
          isPending: false,
          isFetching: false,
          isError: false,
          refetch: () => {},
        }}
        pending={saving}
        priceChanged={null}
        error={null}
        detail={(quote) => (
          <>
            <p className="text-xs text-muted-foreground">
              {selectedForDetail.length} keywords on{" "}
              {devicesLabel(devices)}, checked {scheduleInterval}
            </p>
            <MonthlyProjection monthly={quote.monthly} />
          </>
        )}
        onConfirm={(maxUsd) => void handleSave(maxUsd)}
        onClose={() => setApproval(null)}
      />
    </>
  );
}

function StepHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {description ? (
        <DialogDescription>{description}</DialogDescription>
      ) : null}
    </DialogHeader>
  );
}
