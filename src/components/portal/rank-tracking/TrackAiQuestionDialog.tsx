// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FormDialog } from "@/components/app/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { fetchJson, isApiError } from "@/lib/query/fetchJson";
import { trackRankEvent, buildTrackQuestionPayload } from "./telemetry";

export function TrackAiQuestionDialog({
  open,
  brandKey,
  configId,
  keywordId,
  initialKeyword,
  onClose,
}: {
  open: boolean;
  brandKey: string;
  configId: string;
  keywordId: string;
  initialKeyword: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState(initialKeyword);
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetchJson<{
        questionId: string;
        created: boolean;
        revived: boolean;
        linked: boolean;
      }>(
        `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/keywords/${encodeURIComponent(keywordId)}/ai-question`,
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            text: question.trim(),
            topic: topic.trim() || undefined,
          },
        },
      );

      if (res.created) {
        toast("Question added. Approve your panel in Questions to start measuring it.", {
          action: {
            label: "Open Questions",
            onClick: () => router.push("/portal/measurement"),
          },
        });
      } else if (res.revived) {
        toast("Question restored from your archive.");
      } else {
        toast("This question is already in your list.");
      }

      trackRankEvent(
        "rank_tracking:track_question",
        buildTrackQuestionPayload({ created: res.created }),
      );

      queryClient.invalidateQueries({
        queryKey: ["rankResults", brandKey, configId],
      });

      onClose();
    } catch (err) {
      setError(
        isApiError(err)
          ? err.message
          : "Failed to add question. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormDialog
      title="Track as AI question"
      onClose={onClose}
      pending={submitting}
      actions={
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="track-ai-question-form"
            disabled={submitting || !question.trim()}
          >
            {submitting ? "Adding…" : "Add question"}
          </Button>
        </div>
      }
    >
      <form
        id="track-ai-question-form"
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="track-ai-question-text">Question</Label>
          <Input
            id="track-ai-question-text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={submitting}
            required
            autoFocus
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Google AI Overviews are measured on exactly this search. Keep the
            keyword to compare with your ranking, or write it as a buyer would
            ask an assistant to also learn what ChatGPT, Gemini and Perplexity
            say.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="track-ai-question-topic">Topic (optional)</Label>
          <Input
            id="track-ai-question-topic"
            placeholder="e.g. Products, Competitors"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            disabled={submitting}
          />
        </div>
      </form>
    </FormDialog>
  );
}
