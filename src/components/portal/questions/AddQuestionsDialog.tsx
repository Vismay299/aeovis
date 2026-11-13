"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TrackerEditor.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { formatUsd } from "@/shared/pricing";
import type { QuestionsState } from "./hooks/useQuestions";
import { useQuestionMutations, isRevisionConflict } from "./hooks/useQuestionMutations";
import { TopicField } from "./TopicField";
import { QuestionFields } from "./QuestionFields";

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function AddQuestionsDialog({
  open,
  onOpenChange,
  brandKey,
  state,
  questionSetupOn,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandKey: string;
  state: QuestionsState;
  questionSetupOn: boolean;
  onConflict: () => void;
}) {
  const mutations = useQuestionMutations(brandKey);
  const topics = useMemo(() => {
    const names = state.topics.map((t) => t.name).filter(Boolean);
    if (!names.length) return ["General"];
    return names;
  }, [state.topics]);

  const [topic, setTopic] = useState(topics[0] || "General");
  const [fields, setFields] = useState<string[]>(["", "", ""]);
  const [pasteText, setPasteText] = useState("");
  const [generated, setGenerated] = useState<Set<number>>(new Set());
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [costOpen, setCostOpen] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [pendingGenerate, setPendingGenerate] = useState(false);

  const generateQuote = usePriceQuote(
    { brandKey, action: "questions.generate.run", input: { topic } },
    { enabled: Boolean(open && questionSetupOn) }
  );

  useEffect(() => {
    if (open) {
      setTopic(topics[0] || "General");
      setFields(["", "", ""]);
      setPasteText("");
      setGenerated(new Set());
      setConflict(false);
      setError(null);
    }
  }, [open, topics]);

  function applyPaste(text: string) {
    const lines = splitLines(text);
    if (!lines.length) return;
    const next = ["", "", "", "", ""];
    for (let i = 0; i < Math.min(5, lines.length); i++) next[i] = lines[i];
    setFields(next.slice(0, Math.max(3, Math.min(5, lines.length))));
  }

  async function runGenerate(maxUsd?: number) {
    setCostError(null);
    setPendingGenerate(true);
    try {
      const requestId = crypto.randomUUID();
      const excludeQuestions = fields.map((f) => f.trim()).filter(Boolean);
      const res = await mutations.generate.mutateAsync({ requestId, topic, excludeQuestions, maxUsd });
      const qs = res?.questions || [];
      const next = [...fields];
      let added = 0;
      const gen = new Set(generated);
      for (const q of qs) {
        const idx = next.findIndex((v) => !v.trim());
        if (idx === -1) break;
        next[idx] = q;
        gen.add(idx);
        added++;
      }
      if (added < qs.length) toast.success(`Added ${added} questions`);
      setFields(next.slice(0, Math.max(3, next.filter(Boolean).length || 3)).concat(next.length < 5 && next.every(Boolean) ? [] : []));
      setGenerated(gen);
      setCostOpen(false);
    } catch (e: any) {
      setCostError(e?.message || "Could not generate questions.");
    } finally {
      setPendingGenerate(false);
    }
  }

  async function addQuestions() {
    setConflict(false);
    setError(null);
    const questions = fields.map((t) => t.trim()).filter(Boolean).map((text, i) => ({
      text,
      topic: topic.trim() || "General",
      _generated: generated.has(i),
    }));
    if (!questions.length) return;
    // spec: addOrigin manual, or ai_generate for rows that came from Generate and were not edited.
    // We'll submit in one PATCH with addOrigin manual for simplicity unless all generated; easier: split not possible in one call.
    // Minimal: if any generated, mark those with ai_generate via separate calls? No, one PATCH body. We'll use ai_generate when all are generated, else manual.
    const allGenerated = questions.length > 0 && questions.every((q) => (q as any)._generated);
    try {
      await mutations.patch.mutateAsync({
        expectedRevision: state.revision,
        addOrigin: allGenerated ? "ai_generate" : "manual",
        patch: { questions: questions.map(({ text, topic: t }) => ({ text, topic: t })) },
      });
      onOpenChange(false);
    } catch (e) {
      if (isRevisionConflict(e)) {
        setConflict(true);
        onConflict();
      } else {
        setError((e as any)?.message || "Could not add questions.");
      }
    }
  }

  const quoteUsd = (generateQuote.data as any)?.totalUsd;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent fullScreenOnMobile>
          <DialogHeader><DialogTitle>Add questions</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            {conflict ? (
              <Alert variant="destructive"><AlertDescription>These questions changed since you opened them. Reload</AlertDescription></Alert>
            ) : null}
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <TopicField value={topic} onChange={setTopic} topics={topics} />
            <div className="space-y-2">
              <QuestionFields values={fields} onChange={setFields} />
              <Textarea
                aria-label="Paste questions"
                placeholder="Paste multiple lines"
                value={pasteText}
                onChange={(e) => { setPasteText(e.target.value); applyPaste(e.target.value); }}
                rows={3}
              />
            </div>
            {questionSetupOn ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setCostOpen(true)}
                  disabled={pendingGenerate}
                >
                  <Sparkles className="mr-1.5 size-4" />
                  {pendingGenerate ? "Generating…" : "Generate"}
                </Button>
                {typeof quoteUsd === "number" ? (
                  <span className="text-sm text-muted-foreground">Up to {formatUsd(quoteUsd)}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={addQuestions} disabled={mutations.patch.isPending}>Add questions</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {questionSetupOn ? (
        <CostReviewDialog
          open={costOpen}
          title="Generate questions"
          confirmLabel="Generate"
          pendingLabel="Generating…"
          quote={generateQuote as any}
          pending={pendingGenerate}
          priceChanged={null}
          error={costError}
          onConfirm={(maxUsd) => runGenerate(maxUsd)}
          onClose={() => { if (!pendingGenerate) setCostOpen(false); }}
        />
      ) : null}
    </>
  );
}
