"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Ga4Range = "last_7_days" | "last_28_days" | "last_90_days";

export const GA4_RANGE_OPTIONS: { value: Ga4Range; label: string }[] = [
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_28_days", label: "Last 28 days" },
  { value: "last_90_days", label: "Last 90 days" },
];

/** Formats an ISO timestamp as "3:05 PM" in the viewer's locale. */
export function formatDataAsOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Range select, "Data as of" time and the hourly-quota warning (§6.6.3). */
export function AnalyticsToolbar({
  range,
  onRangeChange,
  dataAsOf,
  warnings,
}: {
  range: Ga4Range;
  onRangeChange: (range: Ga4Range) => void;
  dataAsOf: string | null;
  warnings: string[];
}) {
  const asOf = formatDataAsOf(dataAsOf);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Select
        value={range}
        onValueChange={(value) => {
          if (value === "last_7_days" || value === "last_28_days" || value === "last_90_days") {
            onRangeChange(value);
          }
        }}
      >
        <SelectTrigger aria-label="Date range" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GA4_RANGE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {asOf ? (
        <span className="text-sm text-muted-foreground">Data as of {asOf}</span>
      ) : null}
      {warnings.includes("quota_low") ? (
        <span className="text-sm text-muted-foreground">
          Google Analytics' hourly quota for this property is almost used up.
        </span>
      ) : null}
    </div>
  );
}
