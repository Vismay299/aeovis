// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingFilters.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useId } from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Filters } from "@/shared/rank-tracking-filters";

const FILTER_LABEL_CLASS =
  "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

const AI_OVERVIEW_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "shown", label: "Shown" },
  { value: "not_seen", label: "Not seen" },
] as const;

function RangeFilter({
  title,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
}: {
  title: string;
  minValue: string;
  maxValue: string;
  onMinChange: (v: string) => void;
  onMaxChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-2.5">
      <p className={FILTER_LABEL_CLASS}>{title}</p>
      <div className="grid grid-cols-2 gap-2">
        <Input
          className="h-7 text-xs"
          placeholder="Min"
          aria-label={`${title} min`}
          type="number"
          value={minValue}
          onChange={(e) => onMinChange(e.target.value)}
        />
        <Input
          className="h-7 text-xs"
          placeholder="Max"
          aria-label={`${title} max`}
          type="number"
          value={maxValue}
          onChange={(e) => onMaxChange(e.target.value)}
        />
      </div>
    </div>
  );
}

export function RankTrackingFilterPanel({
  draft,
  setDraft,
  activeFilterCount,
  onReset,
}: {
  draft: Filters;
  setDraft: (f: Filters) => void;
  activeFilterCount: number;
  onReset: () => void;
}) {
  const id = useId();
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setDraft({ ...draft, [key]: value });

  return (
    <div className="shrink-0 space-y-3 border-b border-border bg-muted/40 px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-foreground">Refine results</p>
          {activeFilterCount > 0 && (
            <Badge size="sm">{activeFilterCount} active</Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={onReset}
          disabled={activeFilterCount === 0}
        >
          <RotateCcw data-icon="inline-start" className="size-3" />
          Clear all
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-include`} className={FILTER_LABEL_CLASS}>
            Include
          </Label>
          <Input
            id={`${id}-include`}
            placeholder="e.g. seo, tool"
            value={draft.include}
            onChange={(e) => update("include", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-exclude`} className={FILTER_LABEL_CLASS}>
            Exclude
          </Label>
          <Input
            id={`${id}-exclude`}
            placeholder="e.g. free, cheap"
            value={draft.exclude}
            onChange={(e) => update("exclude", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-aio`} className={FILTER_LABEL_CLASS}>
            AI Overview
          </Label>
          <Select
            value={draft.aiOverview}
            onValueChange={(val: string | null) => {
              if (val) update("aiOverview", val as Filters["aiOverview"]);
            }}
          >
            <SelectTrigger id={`${id}-aio`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AI_OVERVIEW_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <RangeFilter
          title="Desktop position"
          minValue={draft.minDesktopPos}
          maxValue={draft.maxDesktopPos}
          onMinChange={(v) => update("minDesktopPos", v)}
          onMaxChange={(v) => update("maxDesktopPos", v)}
        />
        <RangeFilter
          title="Mobile position"
          minValue={draft.minMobilePos}
          maxValue={draft.maxMobilePos}
          onMinChange={(v) => update("minMobilePos", v)}
          onMaxChange={(v) => update("maxMobilePos", v)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <RangeFilter
          title="Volume"
          minValue={draft.minVolume}
          maxValue={draft.maxVolume}
          onMinChange={(v) => update("minVolume", v)}
          onMaxChange={(v) => update("maxVolume", v)}
        />
        <RangeFilter
          title="Keyword difficulty"
          minValue={draft.minKd}
          maxValue={draft.maxKd}
          onMinChange={(v) => update("minKd", v)}
          onMaxChange={(v) => update("maxKd", v)}
        />
        <RangeFilter
          title="CPC"
          minValue={draft.minCpc}
          maxValue={draft.maxCpc}
          onMinChange={(v) => update("minCpc", v)}
          onMaxChange={(v) => update("maxCpc", v)}
        />
      </div>
    </div>
  );
}
