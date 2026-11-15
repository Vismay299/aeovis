"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/PromptExplorerPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { Plus, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trackEvent } from "@/lib/telemetry/client";
import { useTrackExploreQuestion } from "./hooks/useExplore";

type Props = {
  runId: string;
  questionId: string | null;
  brandKey: string;
};

export function TrackQuestionButton({ runId, questionId, brandKey }: Props) {
  const trackMutation = useTrackExploreQuestion(brandKey);

  const isTracked = Boolean(questionId || trackMutation.isSuccess);
  const effectiveQuestionId = questionId ?? trackMutation.data?.questionId ?? null;

  const handleTrack = async () => {
    if (isTracked || trackMutation.isPending) return;
    try {
      await trackMutation.mutateAsync(runId);
      trackEvent("prompt_explorer:question_tracked", {});
      toast.success("Added to your questions. Review them before your next scan.");
    } catch (err: any) {
      toast.error(err?.message || "Could not track question.");
    }
  };

  if (isTracked && effectiveQuestionId) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled className="gap-1.5 opacity-100">
          <Check className="size-4 text-emerald-600 dark:text-emerald-500" />
          <span>Tracked</span>
        </Button>
        <Link
          href={`/portal/questions/${encodeURIComponent(effectiveQuestionId)}`}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
        >
          View history
        </Link>
      </div>
    );
  }

  if (trackMutation.isPending) {
    return (
      <Button variant="outline" size="sm" disabled className="gap-1.5">
        <Loader2 className="size-4 animate-spin" />
        <span>Tracking…</span>
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={handleTrack}
    >
      <Plus className="size-4" />
      <span>Track this question</span>
    </Button>
  );
}
