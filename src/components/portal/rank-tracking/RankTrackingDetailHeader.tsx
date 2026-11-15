// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingDetailHeader.tsx:33-153
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Monitor, Plus, Settings, Smartphone } from "lucide-react";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatLocationLabel, LOCATION_OPTIONS } from "@/shared/keyword-locations";
import { formatNextRun } from "@/shared/schedule";
import { formatUsd } from "@/shared/pricing";
import {
  devicesLabel,
  rankScheduleLabel,
  type ComparePeriod,
  COMPARE_LABELS,
  COMPARE_PERIODS,
} from "@/shared/rank-tracking";
import type { RankTrackerSummary } from "./hooks/useRankTrackers";

const COMPARE_ITEMS: { value: ComparePeriod; label: string }[] = COMPARE_PERIODS.map(
  (period) => ({
    value: period,
    label: COMPARE_LABELS[period],
  }),
);

export function RankTrackingDetailHeader({
  config,
  lastCheckedAt,
  costUsd,
  activeDevice,
  onActiveDeviceChange,
  comparePeriod,
  onComparePeriodChange,
  onConfigure,
  onAddKeywords,
}: {
  config: RankTrackerSummary;
  lastCheckedAt?: string | null;
  costUsd?: number | null;
  activeDevice: "desktop" | "mobile";
  onActiveDeviceChange: (v: "desktop" | "mobile") => void;
  comparePeriod: ComparePeriod;
  onComparePeriodChange: (v: ComparePeriod) => void;
  onConfigure: () => void;
  onAddKeywords: () => void;
}) {
  const hasBothDevices = config.devices === "both";
  const locationText = config.locationName
    ? formatLocationLabel(config.locationName, 2)
    : (LOCATION_OPTIONS.find((loc) => loc.code === config.locationCode)?.label ??
      String(config.locationCode));

  const quoteUsd = costUsd ?? config.approvedMaxUsd;

  return (
    <div className="flex flex-col justify-between gap-3 px-4 pt-4 pb-3 sm:flex-row sm:items-start">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-foreground truncate">
          {config.domain}
        </h2>
        <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span>{locationText}</span>
          <span>·</span>
          {config.devices === "desktop" ? (
            <span>{devicesLabel(config.devices)}</span>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="cursor-help underline decoration-dotted underline-offset-2">
                    {devicesLabel(config.devices)}
                  </span>
                }
              >
                {devicesLabel(config.devices)}
              </TooltipTrigger>
              <TooltipContent>
                Mobile results often differ from desktop. Search Console
                averages both, so its positions may not match.
              </TooltipContent>
            </Tooltip>
          )}
          <span>·</span>
          <span>{rankScheduleLabel(config.scheduleInterval)}</span>
          {config.scheduleInterval !== "manual" && config.nextCheckAt && (
            <>
              <span>·</span>
              <span>Next: {formatNextRun(config.nextCheckAt)}</span>
            </>
          )}
          {lastCheckedAt && (
            <>
              <span>·</span>
              <span>Last: {new Date(lastCheckedAt).toLocaleDateString()}</span>
            </>
          )}
          {quoteUsd != null && quoteUsd > 0 && (
            <>
              <span>·</span>
              <span>up to {formatUsd(quoteUsd)}/check</span>
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {hasBothDevices && (
          <SegmentedToggle
            items={[
              {
                value: "desktop" as const,
                icon: <Monitor className="size-3.5" />,
                label: "Desktop",
              },
              {
                value: "mobile" as const,
                icon: <Smartphone className="size-3.5" />,
                label: "Mobile",
              },
            ]}
            value={activeDevice}
            onChange={(val) => onActiveDeviceChange(val as "desktop" | "mobile")}
          />
        )}

        <Select
          value={comparePeriod}
          onValueChange={(val: string | null) => {
            if (val) onComparePeriodChange(val as ComparePeriod);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Comparison period"
            title="Comparison period"
            className="text-xs w-[140px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPARE_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="hidden h-6 w-px bg-border sm:block" />

        <Button variant="outline" size="sm" onClick={onConfigure}>
          <Settings data-icon="inline-start" className="size-3.5" />
          Configure
        </Button>
        <Button size="sm" onClick={onAddKeywords}>
          <Plus data-icon="inline-start" className="size-3.5" />
          Add Keywords
        </Button>
      </div>
    </div>
  );
}
