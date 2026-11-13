"use client";

import * as React from "react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { QuestionsState } from "./hooks/useQuestions";
import { useQuestionMutations, isRevisionConflict } from "./hooks/useQuestionMutations";

export function NearDuplicates({
  pairs,
  questions,
  expectedRevision,
  brandKey,
  onPatched,
  onConflict,
}: {
  pairs: QuestionsState["nearDuplicates"];
  questions: QuestionsState["questions"];
  expectedRevision: number;
  brandKey: string;
  onPatched: () => void;
  onConflict: () => void;
}) {
  const mutations = useQuestionMutations(brandKey);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (!pairs.length) return null;
  const byId = new Map(questions.map((q) => [q.id, q]));

  async function patch(body: any) {
    try {
      await mutations.patch.mutateAsync({ expectedRevision, patch: body });
      onPatched();
    } catch (e) {
      if (isRevisionConflict(e)) onConflict();
      else toast.error((e as any)?.message || "Could not update questions.");
    }
  }

  return (
    <Alert variant="warning">
      <AlertDescription className="space-y-3">
        <p>These questions look alike. Archive one, or say why both are needed.</p>
        <div className="space-y-3">
          {pairs.map((p, idx) => {
            const left = byId.get(p.leftId);
            const right = byId.get(p.rightId);
            if (!left || !right) return null;
            const key = `${p.leftId}:${p.rightId}`;
            return (
              <div key={key} className="rounded-md border p-3 space-y-2">
                <div className="text-sm"><span className="font-medium">A:</span> {left.text}</div>
                <div className="text-sm"><span className="font-medium">B:</span> {right.text}</div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => patch({ archiveIds: [left.id] })}>Archive first</Button>
                  <Button size="sm" variant="secondary" onClick={() => patch({ archiveIds: [right.id] })}>Archive second</Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 min-w-[220px] space-y-1 text-sm">
                    <span>Why both?</span>
                    <Input
                      value={reasons[key] ?? ""}
                      maxLength={300}
                      onChange={(e) => setReasons((r) => ({ ...r, [key]: e.target.value }))}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const reason = (reasons[key] || "").trim();
                      if (!reason) return;
                      patch({ duplicateReasons: [{ id: right.id, reason }] });
                    }}
                  >
                    Save reason
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </AlertDescription>
    </Alert>
  );
}
