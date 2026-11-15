"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/shared.tsx:97-109, 198-206
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { questionHistoryKeys } from "@/lib/query/keys";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import type {
  historyResponse,
  answerResponse,
} from "@/lib/questions/history/history.contract";
import type { z } from "zod";

export type QuestionHistory = z.infer<typeof historyResponse>;
export type AnswerDetail = z.infer<typeof answerResponse>;
export type ExecutionItem = QuestionHistory["executions"][number];
export type BrandSummaryItem = QuestionHistory["summary"][number];

export function useQuestionHistory({
  brandKey,
  questionId,
  from,
  to,
  engines,
  enabled = true,
}: {
  brandKey: string;
  questionId: string;
  from?: string;
  to?: string;
  engines?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: questionHistoryKeys.history(brandKey, questionId, from, to),
    queryFn: ({ signal }) => {
      let path = `/api/customer/questions/${encodeURIComponent(questionId)}/history`;
      const url = new URL(path, "http://localhost");
      if (from) url.searchParams.set("from", from);
      if (to) url.searchParams.set("to", to);
      if (engines) url.searchParams.set("engines", engines);
      const search = url.search ? url.search : "";
      return fetchJson<QuestionHistory>(withBrand(path + search, brandKey), {
        signal,
      });
    },
    enabled: Boolean(brandKey && questionId) && enabled,
    staleTime: 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  });
}

export function useQuestionAnswer({
  brandKey,
  questionId,
  answerId,
  enabled = true,
}: {
  brandKey: string;
  questionId: string;
  answerId: string | null | undefined;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: questionHistoryKeys.answer(
      brandKey,
      questionId,
      answerId || "none",
    ),
    queryFn: ({ signal }) => {
      const path = `/api/customer/questions/${encodeURIComponent(questionId)}/answers/${encodeURIComponent(answerId!)}`;
      return fetchJson<AnswerDetail>(withBrand(path, brandKey), { signal });
    },
    enabled: Boolean(brandKey && questionId && answerId) && enabled,
    staleTime: 300_000,
    retry: 1,
  });
}

export function aiRate(count: number, eligible: number): string {
  return eligible > 0 ? `${Math.round((count / eligible) * 100)}%` : "—";
}

export function aiDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}
