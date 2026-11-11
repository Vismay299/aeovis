"use client";

import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePortal } from "@/components/portal/PortalShell";
import { formatUsd } from "@/shared/pricing";
import {
  formatNextRun,
  scheduleLabel,
} from "@/shared/schedule";
import type { CustomerScheduleView } from "@/lib/schedules/schedule.contract";
import { useSchedule } from "./hooks/useSchedule";

export type NextRunBadgeProps = {
  schedule?: CustomerScheduleView | null;
  isOwner?: boolean;
  enabled?: boolean;
  isLoading?: boolean;
};

export function NextRunBadge(props?: NextRunBadgeProps) {
  let portalBrandKey = "";
  let portalIsOwner = false;
  let portalFeatureEnabled = false;

  try {
    const portal = usePortal();
    portalBrandKey = portal.brandKey ?? "";
    portalIsOwner = Boolean(portal.isOwner);
    portalFeatureEnabled = Boolean(portal.features?.customer_scheduling);
  } catch {
    // Rendered outside PortalShell in isolated tests
  }

  const isFeatureEnabled = props?.enabled ?? portalFeatureEnabled;
  const isOwner = props?.isOwner ?? portalIsOwner;

  const query = useSchedule(props?.schedule !== undefined ? "" : portalBrandKey);
  const isLoading = props?.isLoading ?? (props?.schedule === undefined && query.isLoading);
  const schedule = props?.schedule !== undefined ? props.schedule : query.data;

  // Rendered only when customer_scheduling is true
  if (!isFeatureEnabled) return null;

  // loading -> nothing
  if (isLoading || !schedule) return null;

  const status = schedule.status;

  if (status === "on") {
    const hasRecentSkip = Boolean(
      schedule.lastSkip &&
        (!schedule.lastRunAt ||
          new Date(schedule.lastSkip.at).getTime() >
            new Date(schedule.lastRunAt).getTime()),
    );

    const nextRunFormatted = schedule.nextRunAt
      ? formatNextRun(schedule.nextRunAt)
      : "—";

    if (hasRecentSkip) {
      return (
        <Link
          href="/portal/settings/schedule"
          className="inline-flex no-underline"
        >
          <Badge variant="warning" className="cursor-pointer gap-1.5">
            <CalendarClock className="size-3.5" />
            {`Next scan ${nextRunFormatted} · last one skipped`}
          </Badge>
        </Link>
      );
    }

    const intervalText = scheduleLabel(schedule.interval ?? "weekly");
    const maxUsdText = formatUsd(schedule.approvedMaxUsd ?? 0);
    const tooltipText = `${intervalText} · up to ${maxUsdText} per scan`;

    return (
      <Tooltip>
        <TooltipTrigger delay={150} render={<span />}>
          <Badge variant="secondary" className="gap-1.5">
            <CalendarClock className="size-3.5" />
            {`Next scan ${nextRunFormatted}`}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    );
  }

  if (status === "operator") {
    const nextRunFormatted = schedule.nextRunAt
      ? formatNextRun(schedule.nextRunAt)
      : "—";
    return (
      <Badge variant="secondary" className="gap-1.5">
        <CalendarClock className="size-3.5" />
        {`Next scan ${nextRunFormatted}`}
      </Badge>
    );
  }

  // off or paused
  if (status === "off" || status === "paused") {
    if (isOwner) {
      return (
        <Link
          href="/portal/settings/schedule"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Scheduled scans off
        </Link>
      );
    }
    return (
      <span className="text-xs text-muted-foreground">
        Scheduled scans off
      </span>
    );
  }

  return null;
}
