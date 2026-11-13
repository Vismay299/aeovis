"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainCompetitorsTable.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useMemo } from "react";
import Link from "next/link";
import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import {
  DataTable,
  useDataTable,
  type DataTableFrameProps,
} from "@/components/app/table/DataTable";
import { HelpLabel } from "@/components/app/HelpLabel";
import { Badge } from "@/components/ui/badge";
import { AddCompetitorButton, canOfferAddCompetitor } from "./AddCompetitorButton";
import type { CompetitorItem } from "./hooks/useDomainCompetitors";

type Props = DataTableFrameProps & {
  brandKey: string;
  rows: CompetitorItem[];
  /** The response's keyword count, for the "Shared keywords" help text. */
  keywordCount: number;
  hasProjectMemory: boolean;
  onCompetitorAdded?: (domain: string) => void;
};

const competitorColumnHelper = createColumnHelper<CompetitorItem>();

function formatOneDecimal(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toFixed(1);
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatRounded(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat().format(Math.round(value));
}

export function DomainCompetitorsTable({
  brandKey,
  rows,
  keywordCount,
  hasProjectMemory,
  onCompetitorAdded,
  ...frame
}: Props) {
  const columns = useMemo<ColumnDef<CompetitorItem, any>[]>(
    () => [
      competitorColumnHelper.accessor("domain", {
        header: () => "Domain",
        cell: ({ row }) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Link
              href={`/portal/domain?domain=${encodeURIComponent(row.original.domain)}`}
              className="font-medium hover:underline"
            >
              {row.original.domain}
            </Link>
            {row.original.isOwnSite ? (
              <Badge variant="secondary">Your site</Badge>
            ) : null}
            {row.original.isDeclaredCompetitor ? (
              <Badge variant="secondary">Competitor</Badge>
            ) : null}
          </span>
        ),
      }),
      competitorColumnHelper.accessor("keywordsCount", {
        header: () => (
          <HelpLabel
            label="Shared keywords"
            helpText={`of ${keywordCount} keywords`}
          />
        ),
        cell: ({ getValue }) => getValue() ?? "—",
      }),
      competitorColumnHelper.accessor("avgPosition", {
        header: () => "Avg. position",
        cell: ({ getValue }) => formatOneDecimal(getValue()),
      }),
      competitorColumnHelper.accessor("visibility", {
        header: () => "Visibility",
        cell: ({ getValue }) => formatPercent(getValue()),
      }),
      competitorColumnHelper.accessor("etv", {
        header: () => "Est. traffic",
        cell: ({ getValue }) => formatRounded(getValue()),
      }),
      competitorColumnHelper.display({
        id: "action",
        header: () => null,
        cell: ({ row }) => {
          const item = row.original;
          if (
            canOfferAddCompetitor({
              hasProjectMemory,
              isOwnSite: item.isOwnSite,
              isDeclaredCompetitor: item.isDeclaredCompetitor,
            })
          ) {
            return (
              <AddCompetitorButton
                brandKey={brandKey}
                domain={item.domain}
                size="sm"
                variant="outline"
                onAdded={onCompetitorAdded}
              />
            );
          }
          if (item.isDeclaredCompetitor) {
            return <Badge variant="secondary">Competitor</Badge>;
          }
          return null;
        },
      }),
    ],
    [brandKey, hasProjectMemory, keywordCount, onCompetitorAdded],
  );

  const table = useDataTable({ data: rows, columns });

  return (
    <DataTable
      table={table}
      empty={{
        kind: "no-data",
        title: "No competing domains found for these keywords.",
      }}
      {...frame}
    />
  );
}
