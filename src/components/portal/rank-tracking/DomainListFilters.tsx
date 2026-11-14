// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingFilters.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DomainListFilters } from "@/shared/rank-tracking-filters";

export type DomainListFilterOptions = {
  devices: { value: string; label: string }[];
  locations: { value: string; label: string }[];
};

const DEVICE_ITEMS = [
  { value: "all", label: "All devices" },
  { value: "mobile", label: "Mobile" },
  { value: "desktop", label: "Desktop" },
  { value: "both", label: "Desktop + Mobile" },
];

/**
 * The domain-list filter bar: search text, device and country. Shown once the
 * list is long enough to need it (or while filters are active).
 */
export function DomainListFilterBar({
  filters,
  options,
  onChange,
  onReset,
}: {
  filters: DomainListFilters;
  options: DomainListFilterOptions;
  onChange: (next: DomainListFilters) => void;
  onReset: () => void;
}) {
  const deviceItems =
    options.devices.length > 0 ? options.devices : DEVICE_ITEMS.slice(1);
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
      <Input
        type="search"
        aria-label="Search tracked domains"
        placeholder="Search domains"
        className="w-52"
        value={filters.query}
        onChange={(event) =>
          onChange({ ...filters, query: event.target.value })
        }
      />
      <Select
        items={[{ value: "all", label: "All devices" }, ...deviceItems]}
        value={filters.device}
        onValueChange={(value) => {
          if (value) onChange({ ...filters, device: value as DomainListFilters["device"] });
        }}
      >
        <SelectTrigger aria-label="Filter by device" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[{ value: "all", label: "All devices" }, ...deviceItems].map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        items={[{ value: "all", label: "All countries" }, ...options.locations]}
        value={filters.locationCode}
        onValueChange={(value) => {
          if (value) onChange({ ...filters, locationCode: value });
        }}
      >
        <SelectTrigger aria-label="Filter by country" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[{ value: "all", label: "All countries" }, ...options.locations].map(
            (item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        onClick={onReset}
      >
        Clear filters
      </button>
    </div>
  );
}
