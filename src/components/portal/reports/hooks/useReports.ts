// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/reports/shared.tsx:36-53
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F23 §6.5 — the customer report reads and writes the UI needs. Query keys
// come from the F05 registry; every key here has `staleTime: 0` because these
// pages exist to inspect what the assistant just wrote, so the app-wide
// five-minute staleTime would show a pre-save list as current.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { keys } from "@/shared/query/keys";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { trackEvent } from "@/shared/telemetry/client";
import { REPORT_APP_LIST_LIMIT } from "@/shared/reports";

// Wire shapes (§6.5): the list carries no `html`, no `summary` and no token;
// the detail adds the current link, its 30-day views and the writing chat.
export type ReportListItem = {
  id: string;
  title: string;
  skill: string | null;
  skillTitle: string | null;
  templateId: string | null;
  templateName: string | null;
  createdBy: string;
  createdByYou: boolean;
  htmlBytes: number;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ReportDetailItem = ReportListItem & {
  shareToken: string | null;
  sharedAt: string | null;
  views30d: number | null;
  chatPath: string | null;
};

export type ReportTemplateItem = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
};

export function reportsQueryOptions(brandKey: string) {
  return {
    queryKey: keys.reports(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ reports: ReportListItem[] }>(
        withBrand("/api/customer/reports", brandKey, {
          limit: REPORT_APP_LIST_LIMIT,
        }),
        { signal },
      ),
    enabled: Boolean(brandKey),
    staleTime: 0,
  };
}

export function reportQueryOptions(brandKey: string, reportId: string) {
  return {
    queryKey: keys.report(reportId),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ report: ReportDetailItem }>(
        withBrand(
          `/api/customer/reports/${encodeURIComponent(reportId)}`,
          brandKey,
        ),
        { signal },
      ),
    enabled: Boolean(brandKey && reportId),
    staleTime: 0,
    // A deleted report is a 404, not a flake; retrying it only delays the
    // not-found copy by several seconds.
    retry: false,
  };
}

export function reportTemplatesQueryOptions(brandKey: string) {
  return {
    queryKey: keys.reportTemplates(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ templates: ReportTemplateItem[]; remaining: number }>(
        withBrand("/api/customer/reports/templates", brandKey),
        { signal },
      ),
    enabled: Boolean(brandKey),
    staleTime: 0,
  };
}

// One delete flow for the list row and the detail page, so the toast, the
// event and the invalidation cannot drift apart.
export function useDeleteReport(
  brandKey: string,
  { onDeleted }: { onDeleted?: () => void } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) =>
      fetchJson<{ reportId: string; deleted: boolean }>(
        `/api/customer/reports/${encodeURIComponent(reportId)}`,
        { method: "DELETE", body: { brand_key: brandKey } },
      ),
    onSuccess: (_result, reportId) => {
      trackEvent("report:deleted", {});
      toast.success("Report deleted");
      void queryClient.invalidateQueries({
        queryKey: keys.reports(brandKey),
      });
      // Drop the detail entry too, or a later visit to that URL renders the
      // deleted report from cache before the refetch turns it into a 404.
      queryClient.removeQueries({ queryKey: keys.report(reportId) });
      onDeleted?.();
    },
  });
}

// Share and unshare in one mutation, keyed by the state the toggle is moving
// to. The response is written straight into the detail query so the dialog
// shows the new link without waiting for a refetch; the list is invalidated
// because its rows carry the same sharing flag.
export function useShareReport(brandKey: string, reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // The dialog renders the refusal inline next to the toggle ("Failed to
    // update sharing"), so the shared error toast stays off.
    meta: { errorToast: false },
    mutationFn: (shared: boolean) =>
      fetchJson<{ shareToken: string | null; sharedAt: string | null }>(
        `/api/customer/reports/${encodeURIComponent(reportId)}/share`,
        { method: "POST", body: { brand_key: brandKey, public: shared } },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<{ report: ReportDetailItem }>(
        keys.report(reportId),
        (previous) =>
          previous
            ? {
                report: {
                  ...previous.report,
                  shareToken: result.shareToken,
                  sharedAt: result.sharedAt,
                  shared: result.shareToken !== null,
                },
              }
            : previous,
      );
      void queryClient.invalidateQueries({
        queryKey: keys.reports(brandKey),
      });
    },
  });
}
