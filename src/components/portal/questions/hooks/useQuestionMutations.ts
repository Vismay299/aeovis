"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { keys } from "@/shared/query/keys";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { ApiError } from "@/shared/query/fetchJson";
import type { QuestionsState } from "./useQuestions";

export type QuestionsPatch = {
  questions?: Array<{ id?: string; text: string; topic?: string; paused?: boolean }>;
  archiveIds?: string[];
  reviveIds?: string[];
  setTopic?: { ids: string[]; topic: string };
  duplicateReasons?: Array<{ id: string; reason: string | null }>;
};

export type PatchBody = {
  expectedRevision: number;
  patch?: QuestionsPatch;
  addOrigin?: "manual" | "ai_generate" | "prompt_research";
  addSourceRef?: Record<string, string | number | boolean>;
  settings?: { persona?: string; country?: string; language?: string };
};

function questionsUrl(path = "") {
  return `/api/customer/questions${path}`;
}

export function useQuestionMutations(brandKey: string) {
  const queryClient = useQueryClient();
  const key = keys.questions(brandKey);

  function replaceState(state: QuestionsState) {
    queryClient.setQueryData(key, state);
  }

  const patch = useMutation({
    mutationFn: async (body: PatchBody) => {
      const res = await fetchJson<QuestionsState & { created?: number; updated?: number; skipped?: number }>(
        withBrand(questionsUrl(), brandKey),
        {
          method: "PATCH",
          body: { ...body, brand_key: brandKey },
        }
      );
      return res;
    },
    onSuccess: (data) => {
      replaceState(data as QuestionsState);
      toast.success("Questions updated");
    },
  });

  const approve = useMutation({
    mutationFn: async (body: { expectedRevision: number }) => {
      return fetchJson<{ panel: any; state: QuestionsState }>(
        withBrand(questionsUrl("/approve"), brandKey),
        {
          method: "POST",
          body: { ...body, brand_key: brandKey },
        }
      );
    },
    onSuccess: (data) => {
      if (data?.state) replaceState(data.state);
    },
  });

  const startSetup = useMutation({
    mutationFn: async (body: { maxUsd?: number }) => {
      return fetchJson<{ jobId: string; status: string; pollAfterSeconds: number }>(
        withBrand(questionsUrl("/setup"), brandKey),
        {
          method: "POST",
          body: { ...body, brand_key: brandKey },
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const saveSetup = useMutation({
    mutationFn: async (body: {
      jobId: string;
      expectedRevision: number;
      overview?: string;
      competitors: Array<{ name: string; domain: string; notes: string }>;
      selectedCandidateIds: string[];
      persona: string;
      country: string;
      language: string;
      approve: boolean;
    }) => {
      return fetchJson<{ saved: any; panel: any | null; state: QuestionsState; approveError?: { code: string; message: string } }>(
        withBrand(questionsUrl("/setup/save"), brandKey),
        {
          method: "POST",
          body: { ...body, brand_key: brandKey },
        }
      );
    },
    onSuccess: (data) => {
      if (data?.state) replaceState(data.state);
    },
  });

  const generate = useMutation({
    mutationFn: async (body: { requestId: string; topic?: string; excludeQuestions?: string[]; maxUsd?: number }) => {
      return fetchJson<{ topic: string; questions: string[] }>(
        withBrand(questionsUrl("/generate"), brandKey),
        {
          method: "POST",
          body: { ...body, brand_key: brandKey },
        }
      );
    },
  });

  const research = useMutation({
    mutationFn: async (body: { requestId: string; keyword: string; maxUsd?: number }) => {
      return fetchJson<any>(
        withBrand(questionsUrl("/research"), brandKey),
        {
          method: "POST",
          body: { ...body, brand_key: brandKey },
        }
      );
    },
  });

  return { patch, approve, startSetup, saveSetup, generate, research, replaceState };
}

export function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === "revision_conflict";
}
