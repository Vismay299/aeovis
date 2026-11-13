"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { formatUsd } from "@/shared/pricing";
import type { QuestionsState } from "../hooks/useQuestions";
import { useQuestionResearchKeywords } from "../hooks/useQuestions";
import { useQuestionMutations, isRevisionConflict } from "../hooks/useQuestionMutations";
import { QuestionResearchTable } from "./QuestionResearchTable";

function titleCase(s: string) {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}

export function QuestionResearch({
  open,
  onOpenChange,
  brandKey,
  state,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandKey: string;
  state: QuestionsState;
  onConflict: () => void;
}) {
  const mutations = useQuestionMutations(brandKey);
  const keywords = useQuestionResearchKeywords(brandKey, open);
  const [keyword, setKeyword] = useState("");
  const [result, setResult] = useState<any>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [topic, setTopic] = useState("");
  const [costOpen, setCostOpen] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [searching, setSearching] = useState(false);

  const quote = usePriceQuote(
    { brandKey, action: "questions.research.run", input: { keyword: keyword.trim() } },
    { enabled: Boolean(open && keyword.trim()) }
  );

  useEffect(() => {
    if (open) {
      setKeyword("");
      setResult(null);
      setSelected({});
      setTopic("");
    }
  }, [open]);

  async function runSearch(maxUsd?: number) {
    if (!keyword.trim()) return;
    setCostError(null);
    setSearching(true);
    try {
      const requestId = crypto.randomUUID();
      const res = await mutations.research.mutateAsync({ requestId, keyword: keyword.trim(), maxUsd });
      setResult(res);
      setTopic(titleCase(keyword.trim()));
      setSelected({});
      setCostOpen(false);
    } catch (e: any) {
      setCostError(e?.message || "Question research is unavailable right now. Please retry.");
    } finally {
      setSearching(false);
    }
  }

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const topics = state.topics.map((t) => t.name);

  async function addSelected() {
    const rows = (result?.questions || []).filter((q: any) => selected[q.text]);
    if (!rows.length) return;
    try {
      await mutations.patch.mutateAsync({
        expectedRevision: state.revision,
        addOrigin: "prompt_research",
        addSourceRef: { kind: "question_research", keyword: keyword.trim() },
        patch: { questions: rows.map((q: any) => ({ text: q.text, topic: topic || titleCase(keyword.trim()) })) },
      });
      onOpenChange(false);
    } catch (e) {
      if (isRevisionConflict(e)) onConflict();
      else toast.error((e as any)?.message || "Could not add questions.");
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent fullScreenOnMobile className="max-w-4xl">
          <DialogHeader><DialogTitle>Research questions</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[220px] space-y-1.5">
                <Label htmlFor="research-keyword">Keyword</Label>
                <Input id="research-keyword" aria-label="Keyword" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
              </div>
              <Button onClick={() => setCostOpen(true)} disabled={!keyword.trim() || searching}>
                {searching ? "Searching…" : "Search"}
              </Button>
              {typeof (quote.data as any)?.totalUsd === "number" ? (
                <span className="text-sm text-muted-foreground">Up to {formatUsd((quote.data as any).totalUsd)}</span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {(keywords.data?.keywords || []).map((k) => (
                <Button key={k} variant="outline" size="sm" onClick={() => setKeyword(k)}>{k}</Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Questions come from a US English dataset built from Google "People also ask". They show what people search for, not what they ask AI assistants.
            </p>
            {result?.recent ? (
              <p className="text-sm text-muted-foreground">You researched this on {result.recent.entryDate}: {result.recent.summary}</p>
            ) : null}
            <QuestionResearchTable
              questions={result?.questions || []}
              selected={selected}
              onSelectedChange={setSelected}
            />
          </div>
          <DialogFooter className="flex flex-wrap items-center gap-2 sm:justify-between">
            <div className="flex items-center gap-2">
              <Label>Topic</Label>
              <Select value={topic || titleCase(keyword || "")} onValueChange={(v) => setTopic(v ?? "")}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(topics.length ? topics : ["General"]).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  {keyword ? <SelectItem value={titleCase(keyword)}>{titleCase(keyword)}</SelectItem> : null}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={addSelected} disabled={selectedCount === 0}>Add {selectedCount} questions</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CostReviewDialog
        open={costOpen}
        title="Research questions"
        confirmLabel="Search"
        pendingLabel="Searching…"
        quote={quote as any}
        pending={searching}
        priceChanged={null}
        error={costError}
        onConfirm={(maxUsd) => runSearch(maxUsd)}
        onClose={() => { if (!searching) setCostOpen(false); }}
      />
    </>
  );
}
