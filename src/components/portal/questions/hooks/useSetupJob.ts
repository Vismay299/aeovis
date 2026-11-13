"use client";

import { useMemo } from "react";
import { useJobStatus, type JobStatusResponse } from "@/components/app/hooks/useJobStatus";

export type SetupReview = {
  version: number;
  overview: { text: string; preserved: boolean };
  persona: string;
  competitors: {
    preserved: boolean;
    items: Array<{ name: string; domain: string; notes: string; sourceUrl: string }>;
  };
  candidates: Array<{
    id: string;
    text: string;
    topic: string;
    origin: "ai_setup" | "promptgen";
    branded: boolean;
    eliciting: boolean;
    selected: boolean;
    existing: { questionId: string; status: string } | null;
  }>;
  topics: string[];
  suggestedKeywords: string[];
  warnings: Array<{ code: string; message: string }>;
};

export function useSetupJob(
  brandKey: string,
  jobId: string | null | undefined,
  options?: { onFinish?: (data: JobStatusResponse) => void }
) {
  const job = useJobStatus(brandKey, jobId, options);
  const review = useMemo(() => {
    const result = job.data?.result as { review?: SetupReview } | undefined;
    return result?.review ?? null;
  }, [job.data?.result]);
  return { ...job, review };
}
