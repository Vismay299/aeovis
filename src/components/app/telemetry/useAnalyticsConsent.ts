"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { fetchJson } from "@/shared/query/fetchJson";
import { privacyKeys } from "@/shared/query/keys";
import { writePrivacyCookie } from "@/shared/privacy-choices";
import {
  startAnalyticsCapture,
  stopAnalyticsCapture,
  trackEvent,
} from "@/shared/telemetry/client";

export type PrivacyChoiceResponse = {
  analytics: boolean | null;
  decidedAt: string | null;
  source: "onboarding" | "settings" | "banner" | null;
  policyVersion: string;
  telemetryAvailable: boolean;
};

export function useAnalyticsConsent() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: privacyKeys.choice(),
    queryFn: () => fetchJson<PrivacyChoiceResponse>("/api/customer/privacy"),
    staleTime: 60_000,
  });

  const save = useCallback(
    async (
      analytics: boolean,
      source: "onboarding" | "settings" | "banner",
    ) => {
      const updated = await fetchJson<PrivacyChoiceResponse>(
        "/api/customer/privacy",
        {
          method: "PUT",
          body: { analytics, source },
        },
      );

      queryClient.setQueryData(privacyKeys.choice(), updated);
      writePrivacyCookie(analytics);

      if (analytics) {
        startAnalyticsCapture();
        trackEvent("privacy:analytics_enabled", { source });
      } else {
        stopAnalyticsCapture();
      }

      await queryClient.invalidateQueries({
        queryKey: privacyKeys.choice(),
      });

      return updated;
    },
    [queryClient],
  );

  return {
    choice: query.data?.analytics ?? null,
    available: query.data?.telemetryAvailable ?? false,
    decidedAt: query.data?.decidedAt ?? null,
    save,
    loading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    query,
  };
}
