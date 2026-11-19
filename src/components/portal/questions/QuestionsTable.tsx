"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import HoldButton from "@/components/kokonutui/hold-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/components/portal/ui";
import { toast } from "sonner";
import { QuestionRowActions, QuestionOriginBadge } from "./QuestionRow";
import { useQuestionMutations, isRevisionConflict } from "./hooks/useQuestionMutations";
import type { QuestionsState } from "./hooks/useQuestions";

type Q = QuestionsState["questions"][number];

function InlineConfirm({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      {/* Held, not clicked: archiving rows cannot be undone from here. */}
      <HoldButton
        variant="destructive"
        holdDuration={1200}
        holdingLabel="Keep holding"
        completeLabel="Archived"
        className="h-8 min-w-0 px-3 text-xs"
        onHoldComplete={async () => {
          await onConfirm();
          setOpen(false);
        }}
      >
        Confirm
      </HoldButton>
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  );
}

export function QuestionsTable({
  questions,
  tab,
  allQuestions,
  expectedRevision,
  brandKey,
  onEdit,
  onConflict,
  searchActive,
}: {
  questions: Q[];
  tab: "active" | "paused" | "archived";
  allQuestions: Q[];
  expectedRevision: number;
  brandKey: string;
  onEdit: (q: Q) => void;
  onChanged: () => void;
  onConflict: () => void;
  searchActive: boolean;
}) {
  const mutations = useQuestionMutations(brandKey);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [moveTopic, setMoveTopic] = useState<string>("");
  const [moving, setMoving] = useState(false);

  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);
  const topics = useMemo(() => {
    const names = new Set<string>();
    for (const q of allQuestions) if (q.status !== "archived") names.add(q.topic);
    return Array.from(names);
  }, [allQuestions]);

  async function runPatch(patch: any) {
    try {
      await mutations.patch.mutateAsync({ expectedRevision, patch });
      setSelected({});
    } catch (e) {
      if (isRevisionConflict(e)) onConflict();
      else toast.error((e as any)?.message || "Could not update questions.");
    }
  }

  if (questions.length === 0) {
    if (searchActive) {
      return (
        <div className="rounded-lg border p-6 text-center">
          <p className="font-medium">No questions match</p>
          <p className="text-sm text-muted-foreground">Clear filters</p>
        </div>
      );
    }
    if (tab === "archived") {
      return <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">Nothing archived</div>;
    }
    return (
      <div className="rounded-lg border p-6 text-center">
        <p className="font-medium">No active questions</p>
        <p className="text-sm text-muted-foreground">Add questions or restore archived ones.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm">
          <span>{selectedIds.length} selected</span>
          {tab !== "archived" ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => runPatch({ questions: selectedIds.map((id) => ({ id, text: allQuestions.find(q=>q.id===id)?.text || "", paused: false })) })}>Resume</Button>
              <Button size="sm" variant="secondary" onClick={() => runPatch({ questions: selectedIds.map((id) => ({ id, text: allQuestions.find(q=>q.id===id)?.text || "", paused: true })) })}>Pause</Button>
              <div className="flex items-center gap-1">
                <Select value={moveTopic} onValueChange={(v) => setMoveTopic(v ?? "")}>
                  <SelectTrigger className="h-8 w-[160px]"><SelectValue placeholder="Move to topic…" /></SelectTrigger>
                  <SelectContent>{topics.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                </Select>
                <Button size="sm" variant="secondary" disabled={!moveTopic || moving} onClick={async () => { setMoving(true); await runPatch({ setTopic: { ids: selectedIds, topic: moveTopic } }); setMoving(false); }}>Move</Button>
              </div>
              <InlineConfirm label="Archive" onConfirm={() => runPatch({ archiveIds: selectedIds })} />
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => runPatch({ reviveIds: selectedIds })}>Restore</Button>
          )}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="w-10 p-2"></th>
              <th className="p-2">Question</th>
              <th className="p-2">Topic</th>
              <th className="p-2 whitespace-nowrap">Added</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => (
              <tr key={q.id} className="border-t align-top">
                <td className="p-2">
                  <Checkbox
                    aria-label={`Select ${q.text}`}
                    checked={Boolean(selected[q.id])}
                    onCheckedChange={(v) => setSelected((s) => ({ ...s, [q.id]: Boolean(v) }))}
                  />
                </td>
                <td className="p-2">
                  <div className="space-y-1">
                    <div>{q.text}</div>
                    <div className="flex flex-wrap gap-1">
                      {q.branded ? <Badge variant="outline">Branded · diagnostic</Badge> : null}
                      <QuestionOriginBadge origin={q.origin} />
                    </div>
                  </div>
                </td>
                <td className="p-2">{q.topic}</td>
                <td className="p-2 whitespace-nowrap">{formatDate(q.createdAt)}</td>
                <td className="p-2">
                  <QuestionRowActions
                    question={q}
                    tab={tab}
                    onEdit={onEdit}
                    onPauseResume={(item) => runPatch({ questions: [{ id: item.id, text: item.text, paused: item.status !== "paused" }] })}
                    onArchive={(item) => runPatch({ archiveIds: [item.id] })}
                    onRestore={(item) => runPatch({ reviveIds: [item.id] })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
