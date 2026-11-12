"use client";

import { Card, CardContent } from "@/components/ui/card";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import type { ResearchScope } from "@/shared/researchScope";

type Props = {
  brandKey: string;
  displayTarget: string;
  domain: string;
  country: string;
  scope: ResearchScope;
  locationCode: number;
  languageCode?: string;
  onRun: (maxUsd: number) => void;
  pending?: boolean;
};

export function DomainNotLoadedCard({
  brandKey,
  displayTarget,
  domain,
  country,
  scope,
  locationCode,
  languageCode,
  onRun,
  pending = false,
}: Props) {
  return (
    <Card>
      <CardContent className="space-y-4 py-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Results for {displayTarget} are not loaded.
          </h2>
          <p className="text-sm text-muted-foreground">
            Running this lookup buys fresh data for {country}.
          </p>
        </div>
        <div>
          <PricedActionButton
            label="Run lookup"
            pendingLabel="Running lookup..."
            brandKey={brandKey}
            action="domain.lookup.run"
            input={{
              domain,
              scope,
              locationCode,
              languageCode,
              tab: "keywords",
              pageSize: 50,
            }}
            pending={pending}
            onRun={onRun}
            dialogTitle="Run domain lookup"
            confirmLabel="Run lookup"
          />
        </div>
      </CardContent>
    </Card>
  );
}
