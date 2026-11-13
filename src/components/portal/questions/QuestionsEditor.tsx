"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/portal/ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { usePortal } from "@/components/portal/PortalShell";
import type { QuestionsState } from "./hooks/useQuestions";
import { useQuestionMutations, isRevisionConflict } from "./hooks/useQuestionMutations";
import { QuestionsTable } from "./QuestionsTable";
import { ApprovalBanner } from "./ApprovalBanner";
import { NearDuplicates } from "./NearDuplicates";
import { AddQuestionsDialog } from "./AddQuestionsDialog";
import { QuestionResearch } from "./research/QuestionResearch";
import { EditQuestionDialog } from "./EditQuestionDialog";
import { ApproveDialog } from "./ApproveDialog";
import { PanelContextCard } from "./PanelContextCard";

export function QuestionsEditor({
  brandKey,
  state,
  questionSetupOn,
  promptResearchOn,
  onRefresh,
}: {
  brandKey: string;
  state: QuestionsState;
  questionSetupOn: boolean;
  promptResearchOn: boolean;
  onRefresh: () => void;
}) {
  const { scan } = usePortal();
  const mutations = useQuestionMutations(brandKey);
  const PCard = Card as any;
  const [tab, setTab] = useState<"active" | "paused" | "archived">("active");
  const [search, setSearch] = useState("");
  const [topicFilter, setTopicFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [editQuestion, setEditQuestion] = useState<any | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [baselineApprovedMax, setBaselineApprovedMax] = useState<number | null>(null);
  const [baselinePriceChanged, setBaselinePriceChanged] = useState<any>(null);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [baselinePending, setBaselinePending] = useState(false);

  const baselineQuote = usePriceQuote(
    { brandKey, action: "ai_visibility.scan.run", input: { panelKey: "default" } },
    { enabled: Boolean(brandKey && baselineOpen) }
  );

  const topics = useMemo(() => state.topics.map((t) => t.name), [state.topics]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.questions.filter((item) => {
      if (item.status !== tab) return false;
      if (topicFilter !== "all" && item.topic !== topicFilter) return false;
      if (q && !item.text.toLowerCase().includes(q) && !item.topic.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [state.questions, tab, topicFilter, search]);

  const canApprove = state.diff.dirty || !state.approved;

  function handleRevisionError(err: unknown) {
    if (isRevisionConflict(err)) {
      setRevisionConflict(true);
      return true;
    }
    return false;
  }

  async function doPatch(body: any, opts?: { keepDialogOpenOnConflict?: boolean }) {
    setRevisionConflict(false);
    try {
      await mutations.patch.mutateAsync(body);
      return true;
    } catch (e) {
      if (handleRevisionError(e)) {
        if (!opts?.keepDialogOpenOnConflict) setAddOpen(false);
        return false;
      }
      throw e;
    }
  }

  return (
    <PCard title="Questions">
      <div className="space-y-4 p-4">
        <ApprovalBanner
          state={state}
          onApprove={() => setApproveOpen(true)}
        />

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
              <TabsList>
                <TabsTrigger value="active">Active ({state.questions.filter(q=>q.status==='active').length})</TabsTrigger>
                <TabsTrigger value="paused">Paused ({state.questions.filter(q=>q.status==='paused').length})</TabsTrigger>
                <TabsTrigger value="archived">Archived ({state.questions.filter(q=>q.status==='archived').length})</TabsTrigger>
              </TabsList>
            </Tabs>
            <Input
              aria-label="Search questions"
              placeholder="Search questions"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <Select value={topicFilter} onValueChange={(v) => setTopicFilter(v ?? "all")}>
              <SelectTrigger className="w-[180px]"><SelectValue placeholder="All topics" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All topics</SelectItem>
                {topics.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setAddOpen(true)}>Add questions</Button>
              {promptResearchOn ? (
                <Button variant="secondary" onClick={() => setResearchOpen(true)}>Research questions</Button>
              ) : null}
              <Button onClick={() => setApproveOpen(true)} disabled={!canApprove}>Approve</Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {state.limits.unarchived} of {state.limits.maxUnarchived} questions · {state.limits.topics} of {state.limits.maxTopics} topics
          </p>
        </div>

        {revisionConflict ? (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>These questions changed since you opened them.</span>
              <Button variant="outline" size="sm" onClick={() => { setRevisionConflict(false); onRefresh(); }}>Reload</Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <NearDuplicates
          pairs={state.nearDuplicates}
          questions={state.questions}
          expectedRevision={state.revision}
          onPatched={onRefresh}
          onConflict={() => setRevisionConflict(true)}
          brandKey={brandKey}
        />

        <QuestionsTable
          questions={filtered}
          tab={tab}
          allQuestions={state.questions}
          expectedRevision={state.revision}
          brandKey={brandKey}
          onEdit={setEditQuestion}
          onChanged={() => {}}
          onConflict={() => setRevisionConflict(true)}
          searchActive={Boolean(search.trim() || topicFilter !== "all")}
        />

        <PanelContextCard
          brandKey={brandKey}
          state={state}
          onConflict={() => setRevisionConflict(true)}
        />

        <AddQuestionsDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          brandKey={brandKey}
          state={state}
          questionSetupOn={questionSetupOn}
          onConflict={() => setRevisionConflict(true)}
        />

        <EditQuestionDialog
          open={Boolean(editQuestion)}
          question={editQuestion}
          onOpenChange={(o) => !o && setEditQuestion(null)}
          brandKey={brandKey}
          expectedRevision={state.revision}
          onConflict={() => setRevisionConflict(true)}
        />

        <ApproveDialog
          open={approveOpen}
          onOpenChange={setApproveOpen}
          state={state}
          brandKey={brandKey}
          onConflict={() => setRevisionConflict(true)}
          onApproved={() => {
            setApproveOpen(false);
            // if no scan running, toast has Run scan button handled in dialog/toast per spec
          }}
          onOfferBaseline={() => {
            setApproveOpen(false);
            setBaselineOpen(true);
          }}
        />

        {promptResearchOn ? (
          <QuestionResearch
            open={researchOpen}
            onOpenChange={setResearchOpen}
            brandKey={brandKey}
            state={state}
            onConflict={() => setRevisionConflict(true)}
          />
        ) : null}

        <CostReviewDialog
          open={baselineOpen}
          title="Run your first scan"
          confirmLabel="Run first scan"
          pendingLabel="Starting…"
          quote={baselineQuote as any}
          pending={baselinePending}
          priceChanged={baselinePriceChanged}
          error={baselineError}
          onConfirm={async (maxUsd) => {
            setBaselineError(null);
            setBaselinePending(true);
            try {
              await (scan as any).confirmStart(maxUsd);
              setBaselineOpen(false);
              setBaselinePriceChanged(null);
            } catch (e: any) {
              // scan tracker may handle; show error inline
              setBaselineError(e?.message || "Could not start the scan.");
            } finally {
              setBaselinePending(false);
            }
          }}
          onClose={() => {
            if (!baselinePending) {
              setBaselineOpen(false);
              setBaselinePriceChanged(null);
              setBaselineError(null);
            }
          }}
        />
      </div>
    </PCard>
  );
}
