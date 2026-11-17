"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/AiResearchSetupGate.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Card } from "@/components/portal/ui";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { SpendRefusedError } from "@/components/app/SpendRefusedError";
import { isSpendRefused } from "@/shared/query/errors";
import { ApiError } from "@/shared/query/fetchJson";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import type { QuestionsState } from "../hooks/useQuestions";
import { useQuestionMutations } from "../hooks/useQuestionMutations";

export function QuestionSetupGate({
  brandKey,
  displayName,
  state,
  failure,
  onStarted,
  onWriteMyself,
}: {
  brandKey: string;
  displayName: string;
  state: QuestionsState;
  failure: QuestionsState["setup"]["failure"];
  onStarted: () => void;
  onWriteMyself: () => void;
}) {
  const mutations = useQuestionMutations(brandKey);
  const [costOpen, setCostOpen] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [overview, setOverview] = useState("");
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [spendError, setSpendError] = useState<any>(null);

  const setupQuote = usePriceQuote(
    { brandKey, action: "questions.setup.run", input: {} },
    { enabled: Boolean(costOpen) }
  );

  async function start(maxUsd?: number) {
    setCostError(null);
    setSpendError(null);
    setPending(true);
    try {
      await mutations.startSetup.mutateAsync({ maxUsd });
      setCostOpen(false);
      onStarted();
    } catch (e: any) {
      if (isSpendRefused(e)) {
        setSpendError(e);
        setCostOpen(false);
      } else {
        setCostError(e?.message || "Could not start research.");
      }
    } finally {
      setPending(false);
    }
  }

  async function saveOverviewAndRetry() {
    setOverviewError(null);
    if (!overview.trim()) return;
    try {
      await fetchJson(withBrand("/api/customer/context", brandKey), {
        method: "PATCH",
        body: {
          brand_key: brandKey,
          ops: [{ op: "insert_section_if_missing", key: "business_overview", content: overview.trim() }],
        },
      });
      setCostOpen(true);
    } catch (e: any) {
      setOverviewError("We couldn't save your description. Try again.");
    }
  }

  const isUnreadable = failure === "website_unreadable";
  const isOtherFailure = failure && failure !== "website_unreadable";

  const PCard = Card as any;
  return (
    <PCard className="mx-auto max-w-2xl" title={undefined as any}>
      <div className="space-y-4 p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-6" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Set up your questions</h2>
          <p className="text-sm text-muted-foreground">
            We'll read your website, check who you compete with, and draft the buyer questions to track. You choose which ones every scan asks.
          </p>
        </div>

        {spendError ? <SpendRefusedError error={spendError} /> : null}

        {isUnreadable ? (
          <div className="space-y-3 text-left">
            <Alert variant="destructive">
              <AlertDescription>
                We couldn't read this website. Its bot protection may be blocking us. Describe your business below and try again.
              </AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <Label htmlFor="setup-overview">What you sell, who buys it, and where</Label>
              <Textarea id="setup-overview" rows={4} maxLength={4000} value={overview} onChange={(e) => setOverview(e.target.value)} />
              {overviewError ? <p className="text-sm text-destructive">{overviewError}</p> : null}
            </div>
            <Button onClick={saveOverviewAndRetry}>Try again</Button>
          </div>
        ) : isOtherFailure ? (
          <div className="space-y-3">
            <Alert variant="destructive">
              <AlertDescription>We couldn't finish researching your website. Try again.</AlertDescription>
            </Alert>
            <Button onClick={() => setCostOpen(true)}>Try again</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Button onClick={() => setCostOpen(true)}>Start research</Button>
            <p className="text-xs text-muted-foreground">Research is paid usage. You approve the amount first.</p>
            <div>
              <Button variant="link" onClick={onWriteMyself}>Write questions myself</Button>
            </div>
          </div>
        )}

        <CostReviewDialog
          open={costOpen}
          title="Start research"
          confirmLabel="Start research"
          pendingLabel="Starting…"
          quote={setupQuote as any}
          pending={pending}
          priceChanged={null}
          error={costError}
          onConfirm={(maxUsd) => start(maxUsd)}
          onClose={() => { if (!pending) setCostOpen(false); }}
        />
      </div>
    </PCard>
  );
}
