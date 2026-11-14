"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FormDialog } from "@/components/app/FormDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson, isApiError, withBrand } from "@/lib/query/fetchJson";
import { describeError } from "@/lib/query/errors";

export function TrackQuestionDialog({
  open,
  onOpenChange,
  brandKey,
  keyword,
  locationCode,
  languageCode,
  onTracked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandKey: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  onTracked?: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState(keyword);
  const [topic, setTopic] = useState("");
  const [pending, setPending] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText(keyword);
      setTopic("");
      setLimitError(null);
      setPending(false);
    }
  }, [open, keyword]);

  if (!open) return null;

  const submit = async () => {
    setPending(true);
    setLimitError(null);
    try {
      const result = await fetchJson<{ question: { id: string }; created: boolean; revived: boolean }>(
        withBrand("/api/customer/keywords/track-question", brandKey),
        {
          method: "POST",
          body: {
            keyword,
            text,
            ...(topic.trim() ? { topic: topic.trim() } : {}),
            locationCode,
            languageCode,
          },
        },
      );
      onOpenChange(false);
      onTracked?.();
      if (result.created) {
        toast.success("Question added. Approve your panel in Questions to start tracking it.", {
          action: { label: "Open Questions", onClick: () => router.push("/portal/measurement") },
        });
      } else if (result.revived) {
        toast.success("Question restored from your archive.");
      } else {
        toast.success("This question is already in your list.");
      }
    } catch (error) {
      if (isApiError(error) && (error.code === "question_limit" || error.code === "topic_limit")) {
        setLimitError(error.message);
        return;
      }
      toast.error(describeError(error, "Questions could not be saved. Please retry."));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormDialog
      title="Track as a question"
      onClose={() => onOpenChange(false)}
      pending={pending}
      actions={
        <>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button pending={pending} disabled={pending || text.trim().length < 2} onClick={() => void submit()}>
            Add question
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="track-question-text">Question</Label>
          <Textarea
            id="track-question-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={1500}
          />
          <p className="text-sm text-muted-foreground">
            Write it the way a buyer would ask an AI assistant, for example “Which brands make the best oversized
            t-shirts in India?”
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="track-question-topic">Topic (optional)</Label>
          <Input
            id="track-question-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={100}
            placeholder="General"
          />
        </div>
        {limitError ? (
          <Alert variant="destructive">
            <AlertDescription>{limitError}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </FormDialog>
  );
}
