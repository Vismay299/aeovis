"use client";

import { useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/query/keys";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";

export type QuestionsState = {
  brandKey: string;
  revision: number;
  settings: {
    persona: string | null;
    country: string;
    language: string;
    researchKeywords: string[];
  };
  questions: Array<{
    id: string;
    text: string;
    topic: string;
    origin: string;
    status: "active" | "paused" | "archived";
    branded: boolean;
    cohort: "core";
    replacedBy: string | null;
    duplicateReason: string | null;
    createdAt: string;
    archivedAt: string | null;
  }>;
  topics: Array<{ name: string; active: number; paused: number }>;
  approved: {
    version: number;
    approvedAt: string;
    questionCount: number;
    diagnosticCount: number;
    carriesQuestionIds: boolean;
  } | null;
  diff: {
    approvedVersion: number | null;
    added: number;
    removed: number;
    contextChanged: boolean;
    dirty: boolean;
  };
  nearDuplicates: Array<{ leftId: string; rightId: string; similarity: number }>;
  limits: {
    unarchived: number;
    maxUnarchived: number;
    topics: number;
    maxTopics: number;
  };
  setup: {
    status: "none" | "running" | "review" | "failed" | "saved";
    jobId: string | null;
    failure: "website_unreadable" | "budget_reached" | "other" | null;
  };
};

export function questionsQueryOptions(brandKey: string) {
  return {
    queryKey: keys.questions(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<QuestionsState>(withBrand("/api/customer/questions", brandKey), {
        signal,
      }),
    enabled: Boolean(brandKey),
    staleTime: 0,
  };
}

export function useQuestions(brandKey: string) {
  return useQuery(questionsQueryOptions(brandKey));
}

export function useQuestionResearchKeywords(brandKey: string, enabled = true) {
  return useQuery({
    queryKey: keys.questionResearchKeywords(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ keywords: string[] }>(
        withBrand("/api/customer/questions/research/keywords", brandKey),
        { signal }
      ),
    enabled: Boolean(brandKey) && enabled,
    staleTime: 60_000,
  });
}
