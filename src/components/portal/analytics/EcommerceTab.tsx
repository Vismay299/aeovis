"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/app/EmptyState";
import { QueryError } from "@/components/app/QueryState";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import { Package, Globe } from "lucide-react";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Report } from "./hooks/useGa4Report";

type EcommerceRow = Record<string, string | number | null>;

function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : "—";
}

function money(value: unknown, currency: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return value.toLocaleString();
  }
}

function activityStatus(activity: unknown): string | null {
  if (typeof activity === "string") return activity;
  if (activity && typeof activity === "object") {
    const status = (activity as { status?: unknown }).status;
    if (typeof status === "string") return status;
  }
  return null;
}

/** E-commerce tab (§6.6.3): items or landing pages, with activity states. */
export function EcommerceTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [ecommerceBreakdown, setEcommerceBreakdown] = useState<"item" | "landing_page">("item");
  const [onlyPurchases, setOnlyPurchases] = useState(false);
  const [offset, setOffset] = useState(0);
  const query = useGa4Report(brandKey, "ecommerce_performance", {
    range,
    limit: 100,
    offset,
    ecommerceBreakdown,
    ...(ecommerceBreakdown === "landing_page" && onlyPurchases
      ? { ecommerceOnlyWithTransactions: true }
      : {}),
  });
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: EcommerceRow[];
        ecommerceActivity?: unknown;
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
        request?: { currencyCode?: string };
      }
    | undefined;

  const rows = data?.rows ?? [];
  const currency = data?.request?.currencyCode ?? "USD";
  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;
  const status = activityStatus(data?.ecommerceActivity);

  const itemColumns: ColumnDef<EcommerceRow>[] = [
    { id: "itemName", header: "Item", cell: ({ row }) => <span className="break-words">{String(row.original.itemName ?? "—")}</span> },
    { id: "itemId", header: "Item ID", cell: ({ row }) => <span className="break-words tabular-nums">{String(row.original.itemId ?? "—")}</span> },
    { id: "itemsViewed", header: "Viewed", cell: ({ row }) => <span className="tabular-nums">{num(row.original.itemsViewed)}</span> },
    { id: "itemsAddedToCart", header: "Added to cart", cell: ({ row }) => <span className="tabular-nums">{num(row.original.itemsAddedToCart)}</span> },
    { id: "itemsPurchased", header: "Purchased", cell: ({ row }) => <span className="tabular-nums">{num(row.original.itemsPurchased)}</span> },
    { id: "itemRevenue", header: "Item revenue", cell: ({ row }) => <span className="tabular-nums">{money(row.original.itemRevenue, currency)}</span> },
  ];

  const landingColumns: ColumnDef<EcommerceRow>[] = [
    {
      id: "landingPage",
      header: "Landing page",
      cell: ({ row }) => {
        const host = String(row.original.hostName ?? "");
        const path = String(row.original.landingPage ?? "");
        const value = host ? `https://${host}${path}` : path;
        return <ExternalUrlCell value={value} label={path || value} />;
      },
    },
    { id: "sessions", header: "Sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.sessions)}</span> },
    { id: "transactions", header: "Transactions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.transactions)}</span> },
    { id: "purchaseRevenue", header: "Revenue", cell: ({ row }) => <span className="tabular-nums">{money(row.original.purchaseRevenue, currency)}</span> },
  ];

  const table = useDataTable<EcommerceRow>({
    data: rows,
    columns: ecommerceBreakdown === "item" ? itemColumns : landingColumns,
    getRowId: (row, index) =>
      ecommerceBreakdown === "item"
        ? `${row.itemId ?? ""}${index}`
        : `${row.hostName ?? ""}${row.landingPage ?? ""}${index}`,
  });

  if (query.isPending) return null;
  if (query.isError && !query.data) {
    return (
      <Ga4ErrorState
        error={query.error}
        canManage={canManage}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }

  if (status === "none") {
    return (
      <EmptyState
        variant="plain"
        title="No e-commerce activity was reported for this period."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 px-4 pt-1">
        {query.isError ? (
          <QueryError
            error={query.error}
            fallback="Couldn't load this report from Google Analytics."
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : null}
        {status === "unknown" ? (
          <Alert>
            <AlertDescription>
              This report is incomplete or limited, so we can't tell whether
              there was e-commerce activity.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      {hasLimitedData ? (
        <div className="px-4"><LimitedDataNotice /></div>
      ) : null}
      <DataTable
        table={table}
        isLoading={query.isPending}
        empty={{ title: "No e-commerce activity was reported for this period." }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-4">
              <SegmentedToggle
                items={[
                  { value: "item", icon: <Package />, label: "Items" },
                  { value: "landing_page", icon: <Globe />, label: "Landing pages" },
                ]}
                value={ecommerceBreakdown}
                onChange={(value) => {
                  setEcommerceBreakdown(value);
                  setOffset(0);
                }}
                showLabels
              />
              {ecommerceBreakdown === "landing_page" ? (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={onlyPurchases}
                    onCheckedChange={(checked) => {
                      setOnlyPurchases(checked === true);
                      setOffset(0);
                    }}
                    aria-label="Only pages with purchases"
                  />
                  Only pages with purchases
                </label>
              ) : null}
              {query.isFetching ? <Spinner className="size-3.5" aria-label="Refreshing" /> : null}
            </div>
            <ExportMenu
              actions={["sheets", "csv", "excel", "json"]}
              disabled={rows.length === 0}
              onExport={(action) =>
                void exportRows({
                  format: action,
                  feature: "ga4_ecommerce_performance",
                  headers:
                    ecommerceBreakdown === "item"
                      ? ["Item", "Item ID", "Viewed", "Added to cart", "Purchased", "Item revenue"]
                      : ["Landing page", "Sessions", "Transactions", "Revenue"],
                  rows: rows.map((row) =>
                    ecommerceBreakdown === "item"
                      ? [row.itemName, row.itemId, row.itemsViewed, row.itemsAddedToCart, row.itemsPurchased, row.itemRevenue]
                      : [`${row.hostName ?? ""}${row.landingPage ?? ""}`, row.sessions, row.transactions, row.purchaseRevenue],
                  ),
                  filename: `${brandKey}-analytics-ecommerce`,
                  records: rows,
                })
              }
            />
          </div>
        }
        footer={
          (data?.pageInfo?.hasMore || (data?.totalRowCount ?? 0) > rows.length) ? (
            <TablePagination
              page={Math.floor(offset / 100) + 1}
              pageSize={100}
              totalCount={data?.totalRowCount ?? null}
              hasNextPage={data?.pageInfo?.hasMore}
              isLoading={query.isFetching}
              onPageChange={(page) => setOffset((page - 1) * 100)}
            />
          ) : undefined
        }
      />
    </div>
  );
}
