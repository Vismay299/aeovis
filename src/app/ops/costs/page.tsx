"use client";

/**
 * F03 §6.6.3 — the operator cost console.
 *
 * It lives outside the customer app: no portal shell, no sidebar, app tokens,
 * light mode only. Its data routes need the operator token cookie, so a 401 is
 * the only "auth" state it has — the page itself renders anywhere.
 *
 * NUMBERS ONLY. This page reads costs and edits F01's spend controls and caps.
 * It never flips dispatch rollout: there is no probe-rollout action here and
 * the page never calls `set_probe_rollout` or touches `probe_dispatch_control`.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { PageHeader } from "@/components/app/PageHeader";
import { ErrorState } from "@/components/app/ErrorState";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CostsByWorkspace } from "@/components/ops/costs/CostsByWorkspace";
import { EstimateAccuracy } from "@/components/ops/costs/EstimateAccuracy";
import { EngineStats } from "@/components/ops/costs/EngineStats";
import { OpenHolds } from "@/components/ops/costs/OpenHolds";
import { ReconciliationQueue } from "@/components/ops/costs/ReconciliationQueue";
import {
  PaidFeatureControls,
  type SpendControl,
} from "@/components/ops/costs/PaidFeatureControls";
import {
  WorkspaceLimits,
  type SpendLimit,
} from "@/components/ops/costs/WorkspaceLimits";
import type { OperatorCosts } from "@/shared/costs";

const AUTH_COPY = "Operator sign-in required. Set the operator token and reload.";
const LOAD_FAILED = "The cost console could not be loaded.";

/** The `/api` perimeter answers 401 before any operator route runs. */
class OperatorAuthRequired extends Error {}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (response.status === 401) throw new OperatorAuthRequired(AUTH_COPY);
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string" && body.error
        ? body.error
        : `${LOAD_FAILED} (${response.status})`,
    );
  }
  return body as T;
}

/** A local calendar day as `YYYY-MM-DD`, for the date inputs. */
function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const DEFAULT_TO = localDay(new Date());
const DEFAULT_FROM = localDay(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));

function CostsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}

export default function OpsCostsPage() {
  const [from, setFrom] = useState(DEFAULT_FROM);
  const [to, setTo] = useState(DEFAULT_TO);
  const [costs, setCosts] = useState<OperatorCosts | null>(null);
  const [controls, setControls] = useState<SpendControl[]>([]);
  const [limits, setLimits] = useState<SpendLimit[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        from: `${from}T00:00:00.000Z`,
        to: `${to}T23:59:59.999Z`,
      });
      const [costsBody, controlsBody, limitsBody] = await Promise.all([
        readJson<OperatorCosts>(`/api/ops/costs?${query.toString()}`),
        readJson<{ controls: SpendControl[] }>("/api/ops/spend/controls"),
        readJson<{ limits: SpendLimit[] }>("/api/ops/spend/limits"),
      ]);
      setCosts(costsBody);
      setControls(Array.isArray(controlsBody.controls) ? controlsBody.controls : []);
      setLimits(Array.isArray(limitsBody.limits) ? limitsBody.limits : []);
      setUnauthorized(false);
    } catch (err) {
      if (err instanceof OperatorAuthRequired) {
        setUnauthorized(true);
        setCosts(null);
      } else {
        setError(err instanceof Error ? err.message : LOAD_FAILED);
      }
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8">
        <PageHeader
          title="Costs"
          description="What every workspace spent, how close our estimates were, the open holds and the reconciliation queue."
        />

        {unauthorized ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>{AUTH_COPY}</AlertTitle>
          </Alert>
        ) : (
          <>
            <Card>
              <CardContent className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ops-costs-from">From</Label>
                  <Input
                    id="ops-costs-from"
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ops-costs-to">To</Label>
                  <Input
                    id="ops-costs-to"
                    type="date"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </div>
                <Button variant="outline" onClick={refresh} pending={loading}>
                  Reload
                </Button>
              </CardContent>
            </Card>

            {error ? (
              <ErrorState
                variant="card"
                message={error}
                action={
                  <Button variant="outline" size="sm" onClick={refresh} pending={loading}>
                    Retry
                  </Button>
                }
              />
            ) : null}

            {loading && !costs ? <CostsSkeleton /> : null}

            {costs ? (
              <div className="space-y-4">
                <CostsByWorkspace rows={costs.byWorkspace} />
                <EstimateAccuracy rows={costs.byEndpoint} />
                <EngineStats rows={costs.engineStats} />
                <OpenHolds rows={costs.openHolds} />
                <ReconciliationQueue
                  rows={costs.reconciliations}
                  onResolved={refresh}
                />
                <PaidFeatureControls controls={controls} onSaved={refresh} />
                <WorkspaceLimits limits={limits} onSaved={refresh} />
                <p className="text-xs text-muted-foreground">
                  {`Price table ${costs.priceVersion}.`}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
