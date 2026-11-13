"use client";

import * as React from "react";
import { useState, useMemo, useCallback } from "react";
import { usePortal } from "@/components/portal/PortalShell";
import { Card } from "@/components/portal/ui";
import { QueryError } from "@/components/app/QueryState";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/EmptyState";
import { useQuestions, type QuestionsState } from "./hooks/useQuestions";
import { useQuestionMutations } from "./hooks/useQuestionMutations";
import { useSetupJob } from "./hooks/useSetupJob";
import { QuestionSetupGate } from "./setup/QuestionSetupGate";
import { SetupProgress } from "./setup/SetupProgress";
import { SetupReview } from "./setup/SetupReview";
import { QuestionsEditor } from "./QuestionsEditor";

function LoadingCard() {
  const PCard = Card as any;
  return (
    <PCard title="Questions">
      <div className="space-y-3 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </PCard>
  );
}

export function QuestionsWorkspace() {
  const { brandKey, brand, features } = usePortal();
  const query = useQuestions(brandKey);
  const mutations = useQuestionMutations(brandKey);
  const state = query.data as QuestionsState | undefined;

  const setupJob = useSetupJob(brandKey, state?.setup?.jobId, {
    onFinish: () => {
      query.refetch();
    },
  });

  const questionSetupOn = Boolean(features?.question_setup);
  const promptResearchOn = Boolean(features?.prompt_research);

  const [dismissSetupFailure, setDismissSetupFailure] = useState(false);
  const [showGateEmpty, setShowGateEmpty] = useState(false);

  const unarchivedCount = state?.limits?.unarchived ?? 0;
  const hasQuestions = unarchivedCount > 0 || (state?.questions?.length ?? 0) > 0;
  const approved = state?.approved ?? null;
  const setupStatus = state?.setup?.status ?? "none";

  const showGate = Boolean(
    state &&
      (setupStatus === "none" || setupStatus === "failed") &&
      unarchivedCount === 0 &&
      !approved
  );

  const body = useMemo(() => {
    if (query.isLoading) return <LoadingCard />;
    if (query.isError || !state) {
      const PCard = Card as any;
      return (
        <PCard title="Questions">
          <div className="p-4">
            <QueryError
              error={query.error}
              fallback="Questions could not be loaded."
              onRetry={() => query.refetch()}
            />
          </div>
        </PCard>
      );
    }

    if (showGate && !showGateEmpty) {
      if (!questionSetupOn) {
        const PCard = Card as any;
        return (
          <PCard title="Questions">
            <div className="p-4">
              <EmptyState
                title="No questions yet"
                description="Add the buyer questions your scans should ask."
                action={
                  <Button onClick={() => setShowGateEmpty(true)}>Add questions</Button>
                }
              />
            </div>
          </PCard>
        );
      }
      return (
        <QuestionSetupGate
          brandKey={brandKey}
          displayName={brand?.display_name || "your workspace"}
          state={state}
          failure={state.setup.failure}
          onStarted={() => {
            setDismissSetupFailure(false);
            query.refetch();
          }}
          onWriteMyself={() => setShowGateEmpty(true)}
        />
      );
    }

    if (setupStatus === "running" && state.setup.jobId) {
      return (
        <SetupProgress
          displayName={brand?.display_name || "your workspace"}
          job={setupJob}
        />
      );
    }

    if (setupStatus === "review" && state.setup.jobId) {
      return (
        <SetupReview
          brandKey={brandKey}
          state={state}
          jobId={state.setup.jobId}
          review={setupJob.review}
          onSaved={() => {
            query.refetch();
          }}
        />
      );
    }

    const showFailureAlert =
      !dismissSetupFailure &&
      (setupStatus === "failed") &&
      (unarchivedCount > 0 || approved);

    return (
      <div className="space-y-4">
        {showFailureAlert ? (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>
                {state.setup.failure === "website_unreadable"
                  ? "We couldn't read this website. Its bot protection may be blocking us."
                  : "We couldn't finish researching your website. Try again."}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setDismissSetupFailure(true)}>
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <QuestionsEditor
          brandKey={brandKey}
          state={state}
          questionSetupOn={questionSetupOn}
          promptResearchOn={promptResearchOn}
          onRefresh={() => query.refetch()}
        />
      </div>
    );
  }, [
    query.isLoading,
    query.isError,
    query.error,
    state,
    showGate,
    showGateEmpty,
    questionSetupOn,
    setupStatus,
    brandKey,
    brand?.display_name,
    setupJob,
    dismissSetupFailure,
    unarchivedCount,
    approved,
    promptResearchOn,
  ]);

  return <div data-testid="questions-workspace">{body}</div>;
}
