"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import type { BacklinksTargetScope } from "@/shared/backlinks";

export function BacklinksNotLoadedCard({
  brandKey,
  target,
  displayTarget,
  scope,
  tab = "backlinks",
  pageSize = 50,
  onRunLookup,
  pending = false,
}: {
  brandKey: string;
  target: string;
  displayTarget: string;
  scope: BacklinksTargetScope;
  /** Tab and page size the overview request sends; the quote must price the same input. */
  tab?: "backlinks" | "domains" | "pages";
  pageSize?: number;
  onRunLookup: (maxUsd: number) => void;
  pending?: boolean;
}) {
  return (
    <Card size="lg">
      <CardHeader>
        <h2 className="text-lg font-semibold break-all">
          Backlinks for {displayTarget} are not loaded.
        </h2>
        <p className="text-sm text-muted-foreground">
          Running this lookup buys fresh backlink data.
        </p>
      </CardHeader>
      <CardContent>
        <PricedActionButton
          brandKey={brandKey}
          action="backlinks.lookup.run"
          input={{ target, scope, tab, pageSize }}
          label="Run lookup"
          pendingLabel="Loading…"
          dialogTitle="Run backlink lookup"
          confirmLabel="Run lookup"
          pending={pending}
          onRun={onRunLookup}
        />
      </CardContent>
    </Card>
  );
}
