"use client";

import { useMemo, useState } from "react";
import { AlertCircle, MapPin } from "lucide-react";
import { CardShell } from "@/components/app/CardShell";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedToggle, type SegmentedToggleItem } from "@/components/app/SegmentedToggle";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { googleMapsPointUrl, parseMapsLocation } from "@/shared/local-coordinates";
import { describeError } from "@/shared/query/errors";
import type { SavedBusinessView } from "./hooks/useLocalBusinesses";
import { useLocalGrid } from "./hooks/useLocalGrid";
import { GridHistory } from "./GridHistory";
import { GridPointTable } from "./GridPointTable";
import { RankGridSvg } from "./RankGridSvg";

export type GridTabProps = {
  brandKey: string;
  business: SavedBusinessView;
  currentGridId: string | null;
  onSelectGridId: (id: string | null) => void;
};

const GRID_SIZES: SegmentedToggleItem<"3" | "5">[] = [
  { value: "3", label: "3×3", icon: null },
  { value: "5", label: "5×5", icon: null },
];

const SPACING_OPTIONS = [0.5, 1, 2, 3, 5, 10] as const;
const ZOOM_OPTIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;

export function GridTab({
  brandKey,
  business,
  currentGridId,
  onSelectGridId,
}: GridTabProps) {
  const [keyword, setKeyword] = useState("");
  const [centreInput, setCentreInput] = useState("");
  const [isEditingCentre, setIsEditingCentre] = useState(false);
  const [gridSize, setGridSize] = useState<"3" | "5">("3");
  const [spacingKm, setSpacingKm] = useState<number>(2);
  const [device, setDevice] = useState<"desktop" | "mobile">("mobile");
  const [zoom, setZoom] = useState<"auto" | number>("auto");

  const businessPoint =
    business.latitude != null && business.longitude != null
      ? { latitude: business.latitude, longitude: business.longitude }
      : null;

  const parsedCentre = useMemo(() => parseMapsLocation(centreInput), [centreInput]);
  const centre = parsedCentre ?? businessPoint;
  const centreLabel =
    parsedCentre || !businessPoint
      ? `${(parsedCentre ?? businessPoint)?.latitude ?? 0}, ${
          (parsedCentre ?? businessPoint)?.longitude ?? 0
        }`
      : `${business.title} (${businessPoint.latitude}, ${businessPoint.longitude})`;

  const {
    grid,
    isLoading,
    isTimedOut,
    refetch,
    history,
    isLoadingHistory,
    startGrid,
    startError,
    isStarting,
  } = useLocalGrid(brandKey, currentGridId);

  const gridNumber = Number(gridSize) as 3 | 5;
  const numericZoom = zoom === "auto" ? undefined : zoom;
  // The zoom the picture is drawn at: the run's own zoom once it exists.
  const displayZoom =
    grid?.zoom ?? numericZoom ?? 12;

  const canRun = Boolean(keyword.trim() && centre);

  const handleRun = async (maxUsd: number) => {
    if (!centre) return;
    const res = await startGrid({
      keyword: keyword.trim(),
      center: centre,
      gridSize: gridNumber,
      spacingKm,
      device,
      zoom: numericZoom,
      target: { businessId: business.id },
      maxUsd,
    });
    if (res?.id) onSelectGridId(res.id);
  };

  const points = grid?.points ?? null;
  const summary = grid?.summary ?? null;

  return (
    <div className="space-y-6" data-slot="grid-tab">
      <div data-slot="grid-controls">
        <CardShell title="Run a map ranking grid">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="grid-keyword">Search term</Label>
              <Input
                id="grid-keyword"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="streetwear store"
              />
              <p className="text-xs text-muted-foreground">
                Use what customers search, not your business name.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Centre</Label>
              {isEditingCentre ? (
                <div className="space-y-1.5">
                  <Input
                    id="grid-centre"
                    value={centreInput}
                    onChange={(event) => setCentreInput(event.target.value)}
                    placeholder="Paste a Google Maps link or 19.0760, 72.8777"
                  />
                  <p className="text-xs text-muted-foreground">
                    Paste the full Google Maps link from your browser's address bar, or
                    coordinates like 19.0760, 72.8777.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setCentreInput("");
                        setIsEditingCentre(false);
                      }}
                    >
                      Use the business location
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsEditingCentre(false)}
                    >
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-foreground">{`Centred on ${centreLabel}`}</span>
                  {centre ? (
                    <a
                      className="inline-flex items-center gap-1 text-xs underline underline-offset-2 text-muted-foreground"
                      href={googleMapsPointUrl(centre.latitude, centre.longitude, displayZoom, keyword)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Google Maps
                    </a>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setIsEditingCentre(true)}
                  >
                    Change centre
                  </Button>
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Grid</Label>
                <SegmentedToggle<"3" | "5">
                  items={GRID_SIZES}
                  value={gridSize}
                  onChange={setGridSize}
                  showLabels
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="grid-spacing">Spacing</Label>
                <Select
                  value={String(spacingKm)}
                  onValueChange={(value) => setSpacingKm(Number(value))}
                >
                  <SelectTrigger id="grid-spacing">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SPACING_OPTIONS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {`${option} km`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="grid-device">Device</Label>
                <Select
                  value={device}
                  onValueChange={(value) => {
                    if (value === "desktop" || value === "mobile") setDevice(value);
                  }}
                >
                  <SelectTrigger id="grid-device">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mobile">Mobile</SelectItem>
                    <SelectItem value="desktop">Desktop</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <details className="rounded-md border border-border bg-muted/20 p-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Advanced
              </summary>
              <div className="mt-3 max-w-xs space-y-1.5">
                <Label htmlFor="grid-zoom">Map zoom</Label>
                <Select
                  value={String(zoom)}
                  onValueChange={(value) =>
                    setZoom(value === "auto" ? "auto" : Number(value))
                  }
                >
                  <SelectTrigger id="grid-zoom">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    {ZOOM_OPTIONS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </details>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {`${gridNumber * gridNumber} Google Maps searches, ${spacingKm} km apart.`}
              </p>
              <PricedActionButton
                label="Run grid"
                pendingLabel="Running grid…"
                brandKey={brandKey}
                action="local.grid.run"
                input={{
                  keyword: keyword.trim(),
                  center: centre ?? { latitude: 0, longitude: 0 },
                  gridSize: gridNumber,
                  spacingKm,
                  device,
                  zoom: numericZoom,
                }}
                enabled={canRun}
                pending={isStarting}
                onRun={handleRun}
                alwaysConfirm
                dialogTitle="Run map ranking grid"
                confirmLabel="Run grid"
                detail={() => (
                  <p className="text-xs text-muted-foreground">
                    {`${gridNumber * gridNumber} Google Maps searches around ${centreLabel}.`}
                  </p>
                )}
              />
            </div>
          </div>
        </CardShell>
      </div>

      {!centre && (
        <Alert className="text-sm">
          Save this business with a location first so the grid has a centre.
        </Alert>
      )}

      {startError && (
        <Alert variant="destructive" className="text-sm" data-slot="grid-start-error">
          {describeError(startError, "The grid could not be started. Please retry.")}
        </Alert>
      )}

      {isLoading && !grid && (
        <CardShell title="Map ranking grid">
          <div className="space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        </CardShell>
      )}

      {grid?.status === "processing" && (
        <div data-slot="grid-processing">
          <CardShell title="Map ranking grid">
            <div className="space-y-4">
              <RankGridSvg
                points={null}
                gridSize={grid.gridSize}
                spacingKm={grid.spacingKm}
                center={grid.center}
                zoom={grid.zoom}
                keyword={grid.keyword}
                pointsReady={grid.pointsReady}
                pointsTotal={grid.pointsTotal}
              />
              {isTimedOut && (
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Check again
                </Button>
              )}
            </div>
          </CardShell>
        </div>
      )}

      {grid?.status === "failed" && (
        <Alert
          variant="destructive"
          className="space-y-3"
          data-slot="grid-failed"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span className="font-semibold">
              Every map search failed at the data provider. Try again later.
            </span>
          </div>
        </Alert>
      )}

      {grid?.status === "completed" && (
        <div className="space-y-4" data-slot="grid-completed">
          <CardShell title="Map ranking grid">
            <div className="space-y-4">
              <div className="space-y-1 text-sm text-foreground">
                <p data-slot="grid-summary">
                  {"Ranked at "}
                  <strong>
                    {`${summary?.pointsFound ?? 0} of ${summary?.pointsSearched ?? 0}`}
                  </strong>
                  {" points · average rank "}
                  <strong>{summary?.averageRank ?? "—"}</strong>
                  {" where found · top 3 at "}
                  {summary?.top3Count ?? 0}
                  {" · top 10 at "}
                  {summary?.top10Count ?? 0}
                </p>
                {(summary?.failed ?? 0) > 0 ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {`${summary?.failed} searches failed and may still have been charged.`}
                  </p>
                ) : null}
                {grid.reused ? (
                  <p className="text-xs text-muted-foreground">
                    {`Reused the grid you ran ${Math.max(
                      1,
                      Math.round(
                        (Date.now() - new Date(grid.createdAt).getTime()) / 60000
                      )
                    )} minutes ago at no cost.`}
                  </p>
                ) : null}
              </div>

              <RankGridSvg
                points={points}
                gridSize={grid.gridSize}
                spacingKm={grid.spacingKm}
                center={grid.center}
                zoom={grid.zoom}
                keyword={grid.keyword}
              />

              {grid.matched?.title ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="h-3 w-3" />
                  {`Matching: ${grid.matched.title}`}
                </p>
              ) : null}
            </div>
          </CardShell>

          <GridPointTable points={points} />
        </div>
      )}

      <GridHistory
        grids={history}
        currentGridId={grid?.id ?? null}
        onSelect={(id) => onSelectGridId(id)}
        isLoading={isLoadingHistory}
      />
    </div>
  );
}
