"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/query/keys";
import { fetchJson } from "@/lib/query/fetchJson";
import type { SubmissionSource } from "@/shared/indexnow";
import { trackIndexNowEvent } from "../telemetry";

export type IndexNowHostResult = {
  host: string;
  urlCount: number;
  status: "submitted" | "failed";
  engine: "bing" | "yandex" | "yep" | null;
  httpStatus: number | null;
  reason: string | null;
  message: string;
};

export type IndexNowSkippedUrl = {
  url: string;
  reason: "off_site" | "invalid" | "recently_submitted";
};

export type IndexNowSubmitResponse = {
  key: string;
  keyCreated: boolean;
  hosts: IndexNowHostResult[];
  skipped: IndexNowSkippedUrl[];
};

export type IndexNowSubmitVariables = {
  urls: string[];
  source: SubmissionSource;
  sourceRef?: string;
};

export function useIndexNowSubmit(brandKey: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: IndexNowSubmitVariables) => {
      const requestId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : "00000000-0000-4000-8000-000000000000";

      return fetchJson<IndexNowSubmitResponse>(
        "/api/customer/indexnow/submit",
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            urls: variables.urls,
            source: variables.source,
            sourceRef: variables.sourceRef,
            requestId,
          },
        }
      );
    },
    onSuccess: (res, variables) => {
      const submittedHosts = res.hosts.filter(
        (h) => h.status === "submitted"
      ).length;
      trackIndexNowEvent("indexnow:submit", {
        source: variables.source,
        url_count: variables.urls.length,
        hosts: res.hosts.length,
        submitted_hosts: submittedHosts,
        skipped: res.skipped.length,
      });

      void queryClient.invalidateQueries({
        queryKey: keys.indexnowSubmissions(brandKey),
      });
      void queryClient.invalidateQueries({
        queryKey: keys.indexnowSetup(brandKey),
      });
    },
  });
}
