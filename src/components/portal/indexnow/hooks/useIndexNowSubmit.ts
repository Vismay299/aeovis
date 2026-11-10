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

/**
 * RFC 4122 v4 UUID. `crypto.randomUUID` only exists in secure contexts, so over
 * plain http it falls back to `getRandomValues`, then to `Math.random`. The
 * result must be unique per submission: the server treats a repeated requestId
 * as a duplicate and replays the first result.
 */
export function generateRequestId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export function useIndexNowSubmit(brandKey: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: IndexNowSubmitVariables) => {
      const requestId = generateRequestId();

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
