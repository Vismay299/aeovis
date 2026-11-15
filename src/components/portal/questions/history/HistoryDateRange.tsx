"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/PromptDateRange.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HISTORY_RANGES,
  HISTORY_RANGE_LABELS,
  historyPeriod,
  type HistoryPeriod,
  type HistoryRange,
} from "@/shared/question-history";

export function HistoryDateRange({
  value,
  onChange,
}: {
  value: HistoryPeriod;
  onChange: (period: HistoryPeriod) => void;
}) {
  const [customStart, setCustomStart] = useState(value.start || "");
  const [customEnd, setCustomEnd] = useState(value.end || "");

  useEffect(() => {
    setCustomStart(value.start || "");
    setCustomEnd(value.end || "");
  }, [value.start, value.end]);

  const activeStart = value.preset === "custom" ? customStart : value.start;
  const activeEnd = value.preset === "custom" ? customEnd : value.end;
  const isInvalidCustom =
    value.preset === "custom" &&
    (!activeStart || !activeEnd || activeStart > activeEnd);

  const handleStartChange = (newStart: string) => {
    setCustomStart(newStart);
    onChange({ preset: "custom", start: newStart, end: customEnd });
  };

  const handleEndChange = (newEnd: string) => {
    setCustomEnd(newEnd);
    onChange({ preset: "custom", start: customStart, end: newEnd });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.preset}
        onValueChange={(next) => {
          if (!next) return;
          const preset = next as HistoryRange;
          if (preset === "custom") {
            onChange({ preset: "custom", start: customStart, end: customEnd });
          } else {
            onChange(historyPeriod(preset));
          }
        }}
      >
        <SelectTrigger size="sm" aria-label="Analysis date range" className="w-auto">
          <CalendarDays className="size-3.5" aria-hidden="true" />
          <SelectValue placeholder="Date range" />
        </SelectTrigger>
        <SelectContent>
          {HISTORY_RANGES.map((range) => (
            <SelectItem key={range} value={range}>
              {HISTORY_RANGE_LABELS[range]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value.preset === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            aria-label="Period start date"
            className="h-7 w-36 text-xs"
            value={customStart}
            onChange={(event) => handleStartChange(event.target.value)}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="Period end date"
            className="h-7 w-36 text-xs"
            value={customEnd}
            onChange={(event) => handleEndChange(event.target.value)}
          />
        </div>
      )}

      {isInvalidCustom && (
        <p role="alert" className="w-full text-xs text-destructive">
          Choose a start date on or before the end date.
        </p>
      )}
    </div>
  );
}
