"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/query/keys";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import type { KeyFileStatus } from "@/shared/indexnow";
import { trackIndexNowEvent } from "../telemetry";

export type IndexNowSetupData = {
  domain: string;
  key: string | null;
  hosts: Array<{ host: string; status: KeyFileStatus }> | null;
  checkedAt: string | null;
  ready: boolean;
  limits: {
    requestsLastHour: number;
    maxRequestsPerHour: number;
    urlsToday: number;
    maxUrlsPerDay: number;
  };
};

export type IndexNowSetupResponse = {
  domain: string;
  key: string;
  created: boolean;
};

export function useIndexNowSetup(brandKey: string) {
  return useQuery({
    queryKey: keys.indexnowSetup(brandKey),
    queryFn: () =>
      fetchJson<IndexNowSetupData>(
        withBrand("/api/customer/indexnow", brandKey)
      ),
    enabled: Boolean(brandKey),
    staleTime: 0,
    refetchOnMount: true,
  });
}

export function useIndexNowSetupMutation(brandKey: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      fetchJson<IndexNowSetupResponse>("/api/customer/indexnow/setup", {
        method: "POST",
        body: { brand_key: brandKey },
      }),
    onSuccess: (res) => {
      trackIndexNowEvent("indexnow:setup", { created: res.created });
      void queryClient.invalidateQueries({
        queryKey: keys.indexnowSetup(brandKey),
      });
    },
  });
}
