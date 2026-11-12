"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainTableToolbar.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ExportMenu } from "@/components/app/ExportMenu";
import {
  DataTableFilterToggle,
  DataTableToolbar,
} from "@/components/app/table/DataTableToolbar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ExportFormat } from "@/lib/export/exportRows";

type Props = {
  overBudgetLimit: number | null;
  showFilters: boolean;
  onToggleFilters: () => void;
  activeFilterCount: number;
  countLabel: string;
  totalCount: number | null;
  fallbackCount: number;
  onExport: (format: ExportFormat) => void;
  filterPanel: ReactNode;
  costHint?: ReactNode;
  children?: ReactNode;
};

/** The toolbar, over-budget warning and filter panel above a domain table. */
export function DomainTableToolbar({
  overBudgetLimit,
  showFilters,
  onToggleFilters,
  activeFilterCount,
  countLabel,
  totalCount,
  fallbackCount,
  onExport,
  filterPanel,
  costHint,
  children,
}: Props) {
  return (
    <>
      <DataTableToolbar
        actions={
          <ExportMenu
            actions={["sheets", "csv"]}
            onExport={(action) => onExport(action as ExportFormat)}
          />
        }
      >
        <DataTableFilterToggle
          open={showFilters}
          activeCount={activeFilterCount}
          onToggle={onToggleFilters}
        />
        <span className="text-sm text-muted-foreground">
          {(totalCount ?? fallbackCount).toLocaleString()} {countLabel}
        </span>
        {children}
        {costHint ? (
          <span className="text-xs text-muted-foreground">{costHint}</span>
        ) : null}
      </DataTableToolbar>

      {overBudgetLimit != null ? (
        <div className="border-b border-border px-4 py-3">
          <Alert variant="warning">
            <AlertTriangle />
            <AlertDescription className="text-foreground">
              Saved filters exceed this scope&apos;s {overBudgetLimit}-condition
              limit and were not applied. Open Filters to trim them.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {showFilters ? filterPanel : null}
    </>
  );
}
