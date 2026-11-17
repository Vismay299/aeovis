"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, ExternalLink } from "lucide-react";
import { CardShell } from "@/components/app/CardShell";
import { RowActionsMenu } from "@/components/app/RowActionsMenu";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { parseMapsLocation, googleMapsPointUrl } from "@/shared/local-coordinates";
import { describeError } from "@/shared/query/errors";
import type { SavedBusinessView, SaveBusinessInput } from "./hooks/useLocalBusinesses";
import { useLocalSerp, type LocalSerpRow } from "./hooks/useLocalSerp";

export type LocalResultsTabProps = {
  brandKey: string;
  business: SavedBusinessView;
  competitors: SavedBusinessView[];
  onSaveBusiness: (input: SaveBusinessInput) => Promise<unknown>;
};

const DEPTH_OPTIONS = [10, 20, 50, 100] as const;

export function LocalResultsTab({
  brandKey,
  business,
  competitors,
  onSaveBusiness,
}: LocalResultsTabProps) {
  const defaultNear =
    business.latitude != null && business.longitude != null
      ? `${business.latitude}, ${business.longitude}`
      : "";

  const [keyword, setKeyword] = useState("");
  const [nearInput, setNearInput] = useState(defaultNear);
  const [zoom, setZoom] = useState(12);
  const [searchType, setSearchType] = useState<"maps" | "local_finder">("maps");
  const [device, setDevice] = useState<"desktop" | "mobile">("mobile");
  const [depth, setDepth] = useState<number>(20);

  const { result, isSearching, error, search } = useLocalSerp(brandKey);

  const parsedNear = useMemo(() => parseMapsLocation(nearInput), [nearInput]);

  const competitorKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const competitor of competitors) {
      if (competitor.cid) keys.add(`cid:${competitor.cid}`);
      if (competitor.placeId) keys.add(`place:${competitor.placeId}`);
      if (competitor.title) keys.add(`title:${competitor.title.toLowerCase()}`);
    }
    return keys;
  }, [competitors]);

  const isSavedCompetitor = (row: LocalSerpRow): boolean =>
    Boolean(
      (row.cid && competitorKeys.has(`cid:${row.cid}`)) ||
        (row.placeId && competitorKeys.has(`place:${row.placeId}`)) ||
        (row.title && competitorKeys.has(`title:${row.title.toLowerCase()}`))
    );

  const rows = result?.results ?? [];

  const columns = useMemo<ColumnDef<LocalSerpRow>[]>(
    () => [
      {
        accessorKey: "rank",
        header: "Rank",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.rank ?? "—"}</span>
        ),
      },
      {
        accessorKey: "title",
        header: "Business",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">
                {item.title ?? "Untitled"}
              </span>
              {item.isOwn ? (
                <Badge variant="soft" size="sm" className="text-[0.625rem]">
                  You
                </Badge>
              ) : null}
              {!item.isOwn && isSavedCompetitor(item) ? (
                <Badge variant="secondary" size="sm" className="text-[0.625rem]">
                  Competitor
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: "rating",
        header: "Rating",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.rating != null ? `★ ${row.original.rating}` : "—"}
          </span>
        ),
      },
      {
        accessorKey: "votes",
        header: "Reviews",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.votes != null ? row.original.votes : "—"}
          </span>
        ),
      },
      {
        accessorKey: "category",
        header: "Category",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.category ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "isClaimed",
        header: "Claimed",
        cell: ({ row }) => (
          <Badge
            variant={row.original.isClaimed ? "default" : "outline"}
            size="sm"
          >
            {row.original.isClaimed ? "Claimed" : "Unclaimed"}
          </Badge>
        ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        cell: ({ row }) => (
          <span className="text-muted-foreground text-xs">
            {row.original.phone ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "address",
        header: "Address",
        cell: ({ row }) => (
          <span className="block max-w-[12rem] truncate text-muted-foreground text-xs">
            {row.original.address ?? "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <RowActionsMenu label={`Actions for ${item.title ?? "this business"}`}>
              <DropdownMenuItem
                onClick={() => {
                  if (!item.title) return;
                  void onSaveBusiness({
                    role: "competitor",
                    title: item.title,
                    cid: item.cid ?? undefined,
                    placeId: item.placeId ?? undefined,
                    latitude: item.latitude ?? undefined,
                    longitude: item.longitude ?? undefined,
                  });
                }}
              >
                Save as competitor
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (!item.title) return;
                  void onSaveBusiness({
                    role: "own",
                    title: item.title,
                    cid: item.cid ?? undefined,
                    placeId: item.placeId ?? undefined,
                    latitude: item.latitude ?? undefined,
                    longitude: item.longitude ?? undefined,
                  });
                }}
              >
                Use as my business
              </DropdownMenuItem>
              {item.latitude != null && item.longitude != null ? (
                <DropdownMenuItem
                  render={
                    <a
                      href={googleMapsPointUrl(
                        item.latitude,
                        item.longitude,
                        12,
                        item.title ?? undefined
                      )}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <ExternalLink className="size-3.5" />
                  Open on Google Maps
                </DropdownMenuItem>
              ) : null}
            </RowActionsMenu>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSaveBusiness, competitorKeys]
  );

  const table = useDataTable({ data: rows, columns });

  const handleSearch = async (maxUsd: number) => {
    if (!parsedNear) return;
    await search({
      keyword: keyword.trim(),
      near: {
        latitude: parsedNear.latitude,
        longitude: parsedNear.longitude,
        zoom,
      },
      searchType,
      device,
      depth,
      maxUsd,
    });
  };

  const fetchedLabel = result?.fetchedAt
    ? new Date(result.fetchedAt).toLocaleString()
    : null;

  return (
    <div className="space-y-6" data-slot="local-results-tab">
      <div data-slot="results-controls">
        <CardShell title="Search local results">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="results-keyword">Search term</Label>
                <Input
                  id="results-keyword"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="streetwear store"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="results-near">Near</Label>
                <Input
                  id="results-near"
                  value={nearInput}
                  onChange={(event) => setNearInput(event.target.value)}
                  placeholder="Google Maps link or lat, lng"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="results-zoom">Zoom</Label>
                <Input
                  id="results-zoom"
                  type="number"
                  min={4}
                  max={18}
                  value={zoom}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) setZoom(next);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  12 is about one city. Raise it for a neighbourhood, lower it for a
                  metro area.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="results-type">Type</Label>
                <Select
                  value={searchType}
                  onValueChange={(value) => {
                    if (value === "maps" || value === "local_finder") {
                      setSearchType(value);
                    }
                  }}
                >
                  <SelectTrigger id="results-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="maps">Google Maps</SelectItem>
                    <SelectItem value="local_finder">Local Finder</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="results-device">Device</Label>
                <Select
                  value={device}
                  onValueChange={(value) => {
                    if (value === "desktop" || value === "mobile") setDevice(value);
                  }}
                >
                  <SelectTrigger id="results-device">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mobile">Mobile</SelectItem>
                    <SelectItem value="desktop">Desktop</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="results-depth">Results</Label>
                <Select
                  value={String(depth)}
                  onValueChange={(value) => setDepth(Number(value))}
                >
                  <SelectTrigger id="results-depth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPTH_OPTIONS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex justify-end">
              <PricedActionButton
                label="Search"
                pendingLabel="Searching…"
                brandKey={brandKey}
                action="local.serp.search"
                input={{
                  keyword: keyword.trim(),
                  near: parsedNear
                    ? {
                        latitude: parsedNear.latitude,
                        longitude: parsedNear.longitude,
                        zoom,
                      }
                    : { latitude: 0, longitude: 0, zoom },
                  searchType,
                  device,
                  depth,
                }}
                enabled={Boolean(keyword.trim() && parsedNear)}
                pending={isSearching}
                onRun={handleSearch}
                dialogTitle="Search local results"
                confirmLabel="Search"
              />
            </div>
          </div>
        </CardShell>
      </div>

      {error && (
        <Alert variant="destructive" className="text-sm" data-slot="results-error">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>
              {describeError(error, "Local data could not be loaded. Please retry.")}
            </span>
          </div>
        </Alert>
      )}

      {result ? (
        <div className="space-y-3" data-slot="results-output">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground" data-slot="results-summary">
              {result.ownRank != null
                ? `You rank #${result.ownRank} of ${rows.length}`
                : `Your business is not in these ${rows.length} results.`}
            </p>
            {result.cached && fetchedLabel ? (
              <p className="text-xs text-muted-foreground">
                {`Fetched ${fetchedLabel} · reused at no cost`}
              </p>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Google returned no businesses for this search here. Try a lower zoom.
            </p>
          ) : (
            <DataTable
              table={table}
              empty={{
                title: "No businesses found here.",
                description: "Try a lower zoom.",
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
