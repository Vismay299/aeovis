// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import {
  DataTableFilterPanel,
  DataTableRangeFilter,
} from "@/components/app/table/DataTableToolbar";
import { Input } from "@/components/ui/input";
import type { SavedKeywordsFilterValues } from "@/shared/saved-keywords-filters";

/** The saved-keyword filter fields, with §6.6.2's exact labels and placeholders. */
export function SavedKeywordsFilterPanel({
  value,
  activeCount,
  onChange,
  onClear,
}: {
  value: SavedKeywordsFilterValues;
  activeCount: number;
  onChange: (key: keyof SavedKeywordsFilterValues, next: string) => void;
  onClear: () => void;
}) {
  return (
    <DataTableFilterPanel activeCount={activeCount} onReset={onClear}>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="grid gap-1 text-xs">
          Include Terms
          <Input
            aria-label="Include Terms"
            placeholder="audit, checker, template"
            value={value.include}
            onChange={(event) => onChange("include", event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs">
          Exclude Terms
          <Input
            aria-label="Exclude Terms"
            placeholder="jobs, salary, course"
            value={value.exclude}
            onChange={(event) => onChange("exclude", event.target.value)}
          />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <DataTableRangeFilter
          label="Search Volume"
          min={{
            value: value.minVol,
            onChange: (event) => onChange("minVol", event.target.value),
          }}
          max={{
            value: value.maxVol,
            onChange: (event) => onChange("maxVol", event.target.value),
          }}
        />
        <DataTableRangeFilter
          label="CPC (USD)"
          min={{
            step: "0.01",
            value: value.minCpc,
            onChange: (event) => onChange("minCpc", event.target.value),
          }}
          max={{
            step: "0.01",
            value: value.maxCpc,
            onChange: (event) => onChange("maxCpc", event.target.value),
          }}
        />
        <DataTableRangeFilter
          label="Difficulty"
          min={{
            max: 100,
            value: value.minKd,
            onChange: (event) => onChange("minKd", event.target.value),
          }}
          max={{
            max: 100,
            value: value.maxKd,
            onChange: (event) => onChange("maxKd", event.target.value),
          }}
        />
      </div>
    </DataTableFilterPanel>
  );
}
