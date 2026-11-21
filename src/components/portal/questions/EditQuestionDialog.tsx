"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { MessageSquareText } from "lucide-react";
import { useQuestionMutations, isRevisionConflict } from "./hooks/useQuestionMutations";

export function EditQuestionDialog({
  open,
  question,
  onOpenChange,
  brandKey,
  expectedRevision,
  onConflict,
}: {
  open: boolean;
  question: any | null;
  onOpenChange: (open: boolean) => void;
  brandKey: string;
  expectedRevision: number;
  onConflict: () => void;
}) {
  const mutations = useQuestionMutations(brandKey);
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("");
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (question) {
      setText(question.text || "");
      setTopic(question.topic || "General");
      setConflict(false);
    }
  }, [question, open]);

  async function save() {
    if (!question) return;
    setConflict(false);
    try {
      await mutations.patch.mutateAsync({
        expectedRevision,
        patch: { questions: [{ id: question.id, text: text.trim(), topic: topic.trim() || "General" }] },
      });
      onOpenChange(false);
    } catch (e) {
      if (isRevisionConflict(e)) {
        setConflict(true);
        onConflict();
      } else {
        toast.error((e as any)?.message || "Could not save question.");
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fullScreenOnMobile>
        <DialogHeader>
          <div data-slot="dialog-emblem" aria-hidden="true">
            <MessageSquareText />
          </div>
          <DialogTitle>Edit question</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {conflict ? (
            <Alert variant="destructive">
              <AlertDescription>These questions changed since you opened them. Reload</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="edit-question-text">Question</Label>
            <Textarea id="edit-question-text" value={text} onChange={(e) => setText(e.target.value)} rows={4} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-question-topic">Topic</Label>
            <Input id="edit-question-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </div>
          <p className="text-sm text-muted-foreground">
            Questions never change in place. Saving new wording archives this one and adds the new wording, so each wording keeps its own history.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={mutations.patch.isPending || !text.trim()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
