"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/query/fetchJson";
import { onboardingKeys } from "@/lib/query/keys";

export type OnboardingState = {
  enabled: boolean;
  needsOnboarding: boolean;
  completedAt: string | null;
  workspace: {
    brandKey: string;
    displayName: string;
    website: string;
    websiteHost: string;
    role: "owner" | "member";
    telemetryId: string;
    hasScans: boolean;
  } | null;
  visibleSteps: Array<"website" | "search_console" | "analytics" | "preferences" | "first_scan">;
  steps: Record<string, "todo" | "done" | "skipped">;
  market: { country: string; language: string } | null;
  prefill: { website: string; brandName: string | null; questionCount: number } | null;
  handoff: { domain: string | null; scanId: string | null; importedQuestions?: number } | null;
  audit: { available: boolean; auditId: string | null; status: string; pagesCrawled: number; pagesTotal: number } | null;
  research: { available: boolean; status: string; jobId: string | null } | null;
  questions: { curation: boolean; approvedVersion: number | null; active: number; paused: number } | null;
  gsc: { connected: boolean; property: string | null } | null;
  ga4: { available: boolean; connected: boolean } | null;
  preferences: { productUpdatesAvailable: boolean; analyticsAvailable: boolean } | null;
  domainOverview: boolean;
  pollAfterSeconds: number | null;
};

export function useOnboardingState({ scan, domain, enabled }: { scan: string | null; domain: string | null; enabled: boolean }) {
  return useQuery({
    queryKey: onboardingKeys.state(scan, domain),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (scan) query.set("scan", scan);
      if (domain) query.set("domain", domain);
      const suffix = query.size ? `?${query.toString()}` : "";
      return fetchJson<OnboardingState>(`/api/customer/onboarding${suffix}`, { signal });
    },
    enabled,
    retry: false,
    refetchInterval: (query) => query.state.data?.pollAfterSeconds ? query.state.data.pollAfterSeconds * 1000 : false,
    refetchOnWindowFocus: true,
  });
}
