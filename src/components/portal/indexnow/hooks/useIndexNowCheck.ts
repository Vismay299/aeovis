"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/query/keys";
import { fetchJson } from "@/lib/query/fetchJson";
import type { KeyFileStatus } from "@/shared/indexnow";
import { trackIndexNowEvent } from "../telemetry";

export type IndexNowCheckResponse = {
  hosts: Array<{ host: string; status: KeyFileStatus }>;
  checkedAt: string;
  cached: boolean;
};

export function useIndexNowCheck(brandKey: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables?: { force?: boolean }) =>
      fetchJson<IndexNowCheckResponse>("/api/customer/indexnow/check", {
        method: "POST",
        body: {
          brand_key: brandKey,
          force: variables?.force ?? true,
        },
      }),
    onSuccess: (res) => {
      const foundCount = res.hosts.filter((h) => h.status === "found").length;
      trackIndexNowEvent("indexnow:check", {
        hosts: res.hosts.length,
        found: foundCount,
        cached: res.cached,
      });
      void queryClient.invalidateQueries({
        queryKey: keys.indexnowSetup(brandKey),
      });
    },
  });
}
