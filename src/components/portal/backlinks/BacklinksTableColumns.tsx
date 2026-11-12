"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksTableColumns.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight } from "lucide-react";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import { HelpLabel } from "@/components/app/HelpLabel";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type {
  BacklinksRow,
  BacklinksRowsSortField,
} from "@/shared/backlinks";
import {
  formatDecimal,
  formatNumber,
  truncateMiddle,
} from "@/shared/backlinks";

export type DomainRatings = Record<string, number | null>;

export type BacklinksDisplayRow =
  | {
      kind: "link";
      row: BacklinksRow;
      depth: 0 | 1;
      expandable: boolean;
      expanded: boolean;
    }
  | { kind: "status"; domain: string; status: "loading" | "error" | "empty" };

function extractUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

function formatCompactDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function BacklinksSourceLink({
  url,
  maxLength,
  muted = false,
}: {
  url: string;
  maxLength: number;
  muted?: boolean;
}) {
  return (
    <SafeExternalLink
      url={url}
      label={truncateMiddle(extractUrlPath(url), maxLength)}
      className={`inline-flex items-center gap-1 break-all underline-offset-4 hover:underline ${muted ? "text-xs text-muted-foreground" : "text-sm"}`}
    />
  );
}

function BacklinkFlags({ row }: { row: BacklinksRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.isLost ? <Badge variant="destructive">Lost</Badge> : null}
      {row.isBroken ? <Badge variant="warning">Broken</Badge> : null}
      {row.isDofollow === false ? (
        <Badge variant="outline">Nofollow</Badge>
      ) : null}
      {row.linksCount != null && row.linksCount > 1 ? (
        <Badge variant="outline">{row.linksCount} links</Badge>
      ) : null}
    </div>
  );
}

function StatusCell({ status }: { status: "loading" | "error" | "empty" }) {
  if (status === "loading") {
    return (
      <span className="flex items-center gap-2 pl-6 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        Loading links…
      </span>
    );
  }

  return (
    <span
      className={`pl-6 text-sm ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
    >
      {status === "error"
        ? "Couldn't load this domain's links."
        : "No other links from this domain."}
    </span>
  );
}

function SourceCell({
  displayRow,
  onToggleDomain,
}: {
  displayRow: BacklinksDisplayRow;
  onToggleDomain?: (domain: string) => void;
}) {
  if (displayRow.kind === "status") {
    return <StatusCell status={displayRow.status} />;
  }

  const { row, depth, expandable, expanded } = displayRow;
  if (depth > 0) {
    return (
      <div className="break-all pl-6">
        {row.urlFrom ? (
          <BacklinksSourceLink url={row.urlFrom} maxLength={48} muted />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    );
  }

  const domainLabel = row.domainFrom?.replace(/^www\./, "") ?? "—";
  return (
    <div className="flex items-start gap-1.5 break-all">
      {expandable && row.domainFrom && onToggleDomain ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="-ml-1 shrink-0"
          aria-label={`${expanded ? "Hide" : "Show"} all links from ${domainLabel}`}
          aria-expanded={expanded}
          title={`Load all links from ${domainLabel} · up to $0.03`}
          onClick={() => onToggleDomain(row.domainFrom ?? "")}
        >
          <ChevronRight
            className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </Button>
      ) : null}
      <div>
        <div className="font-semibold">{domainLabel}</div>
        {row.urlFrom ? (
          <BacklinksSourceLink url={row.urlFrom} maxLength={48} muted />
        ) : null}
      </div>
    </div>
  );
}

function linkCell(
  render: (row: BacklinksRow) => React.ReactNode,
): (ctx: { row: { original: BacklinksDisplayRow } }) => React.ReactNode {
  return ({ row }) =>
    row.original.kind === "link" ? render(row.original.row) : null;
}

function buildBaseColumns(
  onToggleDomain?: (domain: string) => void,
): ColumnDef<BacklinksDisplayRow>[] {
  return [
    {
      id: "source",
      enableSorting: false,
      header: () => <HelpLabel label="Source" helpText="Page linking to you" />,
      meta: { headerClassName: "min-w-[200px]" },
      cell: ({ row }) => (
        <SourceCell displayRow={row.original} onToggleDomain={onToggleDomain} />
      ),
    },
    {
      id: "target",
      enableSorting: false,
      header: () => (
        <HelpLabel label="Target" helpText="Destination on your site" />
      ),
      meta: { headerClassName: "min-w-[180px]" },
      cell: linkCell((row) => (
        <div className="break-all">
          {row.urlTo ? (
            <BacklinksSourceLink url={row.urlTo} maxLength={40} />
          ) : (
            "—"
          )}
        </div>
      )),
    },
    {
      id: "anchor",
      enableSorting: false,
      header: () => (
        <HelpLabel label="Anchor" helpText="Text or format of the link" />
      ),
      meta: { headerClassName: "min-w-[150px]" },
      cell: linkCell((row) => (
        <div className="space-y-0.5 wrap-anywhere">
          <span className="text-sm">{row.anchor || "No anchor text"}</span>
          {row.itemType ? (
            <div className="text-xs text-muted-foreground">{row.itemType}</div>
          ) : null}
        </div>
      )),
    },
    {
      id: "flags",
      enableSorting: false,
      header: () => (
        <HelpLabel
          label="Flags"
          helpText="Special backlink attributes, such as lost, broken, nofollow, or multiple links from the same source."
        />
      ),
      meta: { headerClassName: "min-w-[110px]" },
      cell: linkCell((row) => <BacklinkFlags row={row} />),
    },
    {
      id: "rank" satisfies BacklinksRowsSortField,
      accessorFn: (displayRow) =>
        displayRow.kind === "link" ? displayRow.row.rank : null,
      header: ({ column }) => (
        <SortableHeader
          column={column}
          label="Link"
          helpText="Authority of the linking page"
          align="right"
        />
      ),
      sortDescFirst: true,
      cell: linkCell((row) => (
        <div className="text-right tabular-nums text-sm">
          {formatNumber(row.rank)}
        </div>
      )),
    },
    {
      id: "domainRank" satisfies BacklinksRowsSortField,
      accessorFn: (displayRow) =>
        displayRow.kind === "link" ? displayRow.row.domainFromRank : null,
      header: ({ column }) => (
        <SortableHeader
          column={column}
          label="DA"
          helpText="Authority of the linking domain"
          align="right"
        />
      ),
      sortDescFirst: true,
      cell: linkCell((row) => (
        <div className="text-right tabular-nums text-sm">
          {formatNumber(row.domainFromRank)}
        </div>
      )),
    },
    {
      id: "spamScore" satisfies BacklinksRowsSortField,
      accessorFn: (displayRow) =>
        displayRow.kind === "link" ? displayRow.row.spamScore : null,
      header: ({ column }) => (
        <SortableHeader
          column={column}
          label="Spam"
          helpText="Estimated spam risk for this backlink. Higher scores are more likely to be manipulative or low quality."
          align="right"
        />
      ),
      sortDescFirst: true,
      cell: linkCell((row) => {
        const value = row.spamScore;
        return (
          <div className="text-right tabular-nums text-sm">
            {value != null ? (
              Math.round(value)
            ) : (
              <span title="Spam score unknown">—</span>
            )}
          </div>
        );
      }),
    },
    {
      id: "firstSeen" satisfies BacklinksRowsSortField,
      accessorFn: (displayRow) =>
        displayRow.kind === "link" ? displayRow.row.firstSeen : null,
      header: ({ column }) => (
        <SortableHeader
          column={column}
          label="First Seen"
          helpText="When this link was first discovered by the crawler"
        />
      ),
      sortDescFirst: true,
      cell: linkCell((row) => (
        <div className="whitespace-nowrap text-sm">
          <div>{formatCompactDate(row.firstSeen)}</div>
          {row.lastSeen ? (
            <div className="text-xs text-muted-foreground">
              Last {formatCompactDate(row.lastSeen)}
            </div>
          ) : null}
        </div>
      )),
    },
  ];
}

export function buildBacklinksColumns(
  domainRatings: DomainRatings | null | undefined,
  onToggleDomain?: (domain: string) => void,
): ColumnDef<BacklinksDisplayRow>[] {
  const baseColumns = buildBaseColumns(onToggleDomain);
  if (!domainRatings) return baseColumns;

  const ratings = domainRatings;
  const drColumn: ColumnDef<BacklinksDisplayRow> = {
    id: "ahrefsDr",
    enableSorting: false,
    header: () => (
      <span className="flex w-full justify-end">
        <HelpLabel
          label="Ahrefs DR"
          helpText="Ahrefs Domain Rating (0-100) for the linking domain."
        />
      </span>
    ),
    cell: linkCell((row) => {
      const domain = row.domainFrom?.replace(/^www\./, "");
      const dr = domain ? (ratings[domain] ?? null) : null;
      return (
        <div className="text-right tabular-nums text-sm">
          {dr == null ? "—" : formatDecimal(dr)}
        </div>
      );
    }),
  };

  const insertAt =
    baseColumns.findIndex((column) => column.id === "domainRank") + 1;
  return [
    ...baseColumns.slice(0, insertAt),
    drColumn,
    ...baseColumns.slice(insertAt),
  ];
}
