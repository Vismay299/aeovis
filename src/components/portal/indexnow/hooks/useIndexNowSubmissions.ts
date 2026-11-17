"use client";

import { useQuery } from "@tanstack/react-query";
import { keys } from "@/shared/query/keys";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import type { SubmissionSource } from "@/shared/indexnow";

export type SubmissionHistoryItem = {
  id: string;
  createdAt: string;
  source: SubmissionSource;
  sourceRef: string | null;
  host: string;
  urlCount: number;
  urls: string[];
  status: "submitted" | "failed";
  engine: "bing" | "yandex" | "yep" | null;
  httpStatus: number | null;
  message: string;
};

export type SubmissionsData = {
  submissions: SubmissionHistoryItem[];
};

export function useIndexNowSubmissions(
  brandKey: string,
  opts?: { source?: SubmissionSource; sourceRef?: string; limit?: number }
) {
  return useQuery({
    queryKey: keys.indexnowSubmissions(brandKey, opts?.source, opts?.sourceRef),
    queryFn: () =>
      fetchJson<SubmissionsData>(
        withBrand("/api/customer/indexnow/submissions", brandKey, {
          source: opts?.source,
          sourceRef: opts?.sourceRef,
          limit: opts?.limit ?? 20,
        })
      ),
    enabled: Boolean(brandKey),
  });
}
