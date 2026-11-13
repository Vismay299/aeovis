// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { RefreshCw } from "lucide-react";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { ExportMenu } from "@/components/app/ExportMenu";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/shared/money";
import { RefreshStatsStatus } from "./RefreshStatsStatus";
import {
  REFRESH_STATS_DETAIL,
  type RefreshStatsController,
} from "./hooks/useRefreshStats";
import type { SavedKeywordsExportFormat } from "./hooks/useSavedKeywordsExport";

/** The saved page's header: the one paid action plus the filtered export. */
export function SavedKeywordsHeader({
  refresh,
  exportEnabled,
  exportBusy,
  onExport,
}: {
  refresh: RefreshStatsController;
  exportEnabled: boolean;
  exportBusy: boolean;
  onExport: (format: SavedKeywordsExportFormat) => void;
}) {
  const { quote } = refresh;
  const price =
    quote.data && !refresh.blocked ? quote.data.totalUsd : undefined;

  return (
    <div className="space-y-2">
      <PageHeader
        title="Saved Keywords"
        description="Save keyword ideas from research, organize them with tags, and revisit when you're ready to act."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-col items-start gap-1">
              <Button
                variant="outline"
                disabled={!refresh.canOpen}
                pending={refresh.pending}
                onClick={refresh.openDialog}
              >
                <RefreshCw data-icon="inline-start" />
                {refresh.label}
              </Button>
              {refresh.blocked ? (
                <p className="text-destructive text-xs">
                  {refresh.blocked.message}
                </p>
              ) : null}
              {quote.isError ? (
                <p className="text-destructive text-xs">
                  Price unavailable.{" "}
                  <button
                    type="button"
                    className="cursor-pointer underline hover:no-underline"
                    onClick={() => void quote.refetch()}
                  >
                    Retry
                  </button>
                </p>
              ) : null}
              {price !== undefined ? (
                <span className="sr-only" aria-live="polite">
                  {`Price: up to ${formatUsd(price)}`}
                </span>
              ) : null}
            </div>
            <ExportMenu
              actions={["sheets", "csv"]}
              busy={exportBusy}
              disabled={!exportEnabled}
              onExport={onExport}
            />
          </div>
        }
      />
      <RefreshStatsStatus active={refresh.running} progress={refresh.progress} />
      <CostReviewDialog
        open={refresh.dialogOpen}
        title="Update keyword stats"
        confirmLabel="Update stats"
        pendingLabel="Starting…"
        quote={quote}
        pending={refresh.pending}
        priceChanged={refresh.priceChanged}
        error={refresh.error}
        detail={() => (
          <p className="text-sm text-muted-foreground">
            {REFRESH_STATS_DETAIL}
          </p>
        )}
        onConfirm={(maxUsd) => void refresh.run(maxUsd)}
        onClose={refresh.closeDialog}
      />
    </div>
  );
}
