"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EmptyState } from "@/components/app/EmptyState";
import { formatTimestamp, relativeTime } from "@/shared/format";
import { formatUsd } from "@/shared/money";
import type { WorkspaceUsage } from "@/shared/costs";

/**
 * F03 §6.6.1 — the newest paid calls. The source badge splits the known half
 * into "Reported" (the provider sent a cost) and "Priced" (our table priced
 * it), names a reserved amount "Estimated", and shows an operator-closed row
 * as "Not billed". On a phone the table becomes two-line rows.
 */

type RecentCall = WorkspaceUsage["recent"][number];

type Source = {
  label: "Reported" | "Priced" | "Estimated" | "Not billed";
  variant: "success" | "secondary" | "warning" | "outline";
};

function sourceOf(call: RecentCall): Source {
  if (call.notBilled) return { label: "Not billed", variant: "outline" };
  switch (call.costSource) {
    case "provider_reported":
      return { label: "Reported", variant: "success" };
    case "price_table":
      return { label: "Priced", variant: "secondary" };
    case "reservation":
      return { label: "Estimated", variant: "warning" };
    default:
      return { label: "Not billed", variant: "outline" };
  }
}

function When({ at }: { at: string }) {
  return (
    <Tooltip>
      <TooltipTrigger delay={150} render={<span />}>
        <span className="whitespace-nowrap">{relativeTime(at)}</span>
      </TooltipTrigger>
      <TooltipContent>{formatTimestamp(at)}</TooltipContent>
    </Tooltip>
  );
}

export function UsageRecent({ recent }: { recent: WorkspaceUsage["recent"] }) {
  // §11 risk 3: Content Studio spend is not in the ledger, so the page says so
  // wherever the recent list appears — including when it is empty, which is
  // exactly when a new workspace would otherwise read "nothing spent" as the
  // whole truth.
  const footnote = (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Scan answers are added here when each scan finishes.
      </p>
      <p className="text-xs text-muted-foreground">
        Content Studio costs are not included yet.
      </p>
    </div>
  );

  if (recent.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState variant="plain" size="sm" title="No paid calls yet." />
        {footnote}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Feature</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.map((call, index) => {
              const source = sourceOf(call);
              return (
                <TableRow key={`${index}-${call.occurredAt}`}>
                  <TableCell>
                    <When at={call.occurredAt} />
                  </TableCell>
                  <TableCell>{call.label}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {call.provider}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(call.usd)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={source.variant}>{source.label}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ul className="divide-y divide-border md:hidden">
        {recent.map((call, index) => {
          const source = sourceOf(call);
          return (
            <li
              key={`${index}-${call.occurredAt}`}
              className="space-y-1 py-2 first:pt-0 last:pb-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{call.label}</span>
                <span className="tabular-nums">{formatUsd(call.usd)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <When at={call.occurredAt} />
                <span aria-hidden>·</span>
                <Badge variant={source.variant}>{source.label}</Badge>
              </div>
            </li>
          );
        })}
      </ul>

      {footnote}
    </div>
  );
}
