"use client";

import { useMemo, useState } from "react";
import { CardShell } from "@/components/app/CardShell";
import { EmptyState } from "@/components/app/EmptyState";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import { ExpandableList } from "@/components/app/ExpandableList";
import { HelpCircle, AlertCircle, MessageSquare } from "lucide-react";
import type { SavedBusinessView } from "./hooks/useLocalBusinesses";
import { useLocalFetch } from "./hooks/useLocalFetch";

export type QuestionAnswer = {
  answer_id?: string | null;
  answer_text?: string | null;
  original_answer_text?: string | null;
  profile_name?: string | null;
  time_ago?: string | null;
  timestamp?: string | null;
};

export type QuestionItem = {
  rank_absolute?: number;
  question_id?: string | null;
  question_text?: string | null;
  profile_name?: string | null;
  time_ago?: string | null;
  timestamp?: string | null;
  items?: QuestionAnswer[] | null;
};

export type QuestionsTabProps = {
  brandKey: string;
  business: SavedBusinessView;
  currentFetchId: string | null;
  onSelectFetchId: (id: string | null) => void;
};

export function QuestionsTab({
  brandKey,
  business,
  currentFetchId,
  onSelectFetchId,
}: QuestionsTabProps) {
  const [depth, setDepth] = useState<20 | 50 | 100>(20);

  const hasCoordinates =
    (business.latitude != null && business.longitude != null) ||
    (business.profile?.latitude != null && business.profile?.longitude != null);

  const {
    fetch: currentFetch,
    isLoading,
    isTimedOut,
    refetch,
    startFetch,
    isStarting,
  } = useLocalFetch(brandKey, currentFetchId, business.id, "questions");

  const items = useMemo<QuestionItem[]>(
    () => (currentFetch?.items as QuestionItem[]) ?? [],
    [currentFetch?.items]
  );

  const handleStart = async (maxUsd: number) => {
    const res = await startFetch({
      kind: "questions",
      businessId: business.id,
      depth,
      maxUsd,
    });
    if (res?.id) {
      onSelectFetchId(res.id);
    }
  };

  return (
    <div className="space-y-6" data-slot="questions-tab">
      <div data-slot="questions-controls">
        <CardShell title="Collect questions & answers">
        {!hasCoordinates ? (
          <p className="text-sm text-muted-foreground">
            Load the full profile first so we know where the business is.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 items-end">
            <div className="space-y-1.5">
              <Label htmlFor="questions-depth">Questions to collect</Label>
              <Select
                value={String(depth)}
                onValueChange={(val) => setDepth(Number(val) as 20 | 50 | 100)}
              >
                <SelectTrigger id="questions-depth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-start sm:col-span-2">
              <PricedActionButton
                label="Collect questions"
                pendingLabel="Collecting…"
                brandKey={brandKey}
                action="local.questions.collect"
                input={{
                  businessId: business.id,
                  depth,
                }}
                pending={isStarting}
                onRun={handleStart}
                dialogTitle="Collect Google Business questions"
                confirmLabel="Collect questions"
              />
            </div>
          </div>
        )}
      </CardShell>
      </div>

      {!currentFetch && !isLoading && !isStarting && (
        <EmptyState
          icon={HelpCircle}
          title="No questions collected yet"
          description="Collect Q&A to see customer questions and answers on this Google profile."
        />
      )}

      {(isLoading || isStarting || currentFetch?.status === "processing") && (
        <div data-slot="questions-processing">
          <CardShell title="Collecting questions">
          <div className="space-y-4" aria-live="polite">
            <div className="text-sm text-muted-foreground">
              Collecting questions… This usually takes 20 to 60 seconds.
            </div>
            {isTimedOut && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300 flex items-center justify-between">
                <span>
                  Still collecting. Come back later to collect it at no extra cost.
                </span>
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Check again
                </Button>
              </div>
            )}
            <div className="space-y-3">
              <Skeleton className="h-28 w-full rounded-lg" />
              <Skeleton className="h-28 w-full rounded-lg" />
            </div>
          </div>
        </CardShell>
        </div>
      )}

      {currentFetch?.status === "failed" && (
        <Alert variant="destructive" className="space-y-3" data-slot="questions-failed">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span className="font-semibold">
              {currentFetch.error?.message ?? "Google data could not be collected. Try again later."}
            </span>
          </div>
          <div>
            <PricedActionButton
              label="Try again"
              pendingLabel="Collecting…"
              brandKey={brandKey}
              action="local.questions.collect"
              input={{
                businessId: business.id,
                depth,
              }}
              pending={isStarting}
              onRun={handleStart}
              dialogTitle="Collect Google Business questions"
              confirmLabel="Try again"
              variant="outline"
            />
          </div>
        </Alert>
      )}

      {currentFetch?.status === "completed" && (
        <div className="space-y-4" data-slot="questions-completed">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Google returned no questions for this business.
            </p>
          ) : (
            <div className="space-y-3">
              {items.map((q, idx) => {
                const answers = q.items ?? [];
                const latestAnswer = answers[0];
                return (
                  <div
                    key={q.question_id ?? `q-${idx}`}
                    className="rounded-lg border border-border bg-card p-4 space-y-3"
                    data-slot="question-card"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{q.profile_name ?? "User"}</span>
                        {q.time_ago && <span>{q.time_ago}</span>}
                      </div>
                      <h4 className="text-base font-semibold text-foreground">
                        {q.question_text ?? "Untitled question"}
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        {answers.length} {answers.length === 1 ? "answer" : "answers"}
                      </p>
                    </div>

                    {latestAnswer && (
                      <div className="rounded-md bg-muted/40 p-3 text-xs space-y-1 border-l-2 border-primary">
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span className="font-semibold text-foreground flex items-center gap-1.5">
                            <MessageSquare className="h-3 w-3" />
                            {latestAnswer.profile_name ?? "Answer"}
                          </span>
                          {latestAnswer.time_ago && <span>{latestAnswer.time_ago}</span>}
                        </div>
                        <p className="text-foreground whitespace-pre-wrap">
                          {latestAnswer.answer_text}
                        </p>
                      </div>
                    )}

                    {answers.length > 1 && (
                      <div className="pt-2 border-t border-border">
                        <span className="text-xs font-medium text-foreground block mb-2">
                          Show all answers
                        </span>
                        <ExpandableList
                          items={answers}
                          renderItem={(ans, aIdx) => (
                            <li key={ans.answer_id ?? aIdx} className="text-xs py-1.5 space-y-0.5">
                              <span className="font-medium text-foreground">
                                {ans.profile_name ?? "User"} {ans.time_ago ? `(${ans.time_ago})` : ""}:
                              </span>
                              <p className="text-muted-foreground whitespace-pre-wrap">
                                {ans.answer_text}
                              </p>
                            </li>
                          )}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
