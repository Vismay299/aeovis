"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchJson } from "@/lib/query/fetchJson";
import { trackExport } from "@/lib/export/telemetry";

export type ServerExportKind = "workspace_answers";

export type ServerExportRequest = {
  brandKey: string;
  kind: ServerExportKind;
  format: "csv" | "json";
  params: { from: string; to: string };
};

export type ServerExportResponse = {
  exportId: string;
  url: string;
  expiresAt: string;
  format: "csv" | "json";
  rowCount: number;
  filename: string;
};

/**
 * F06 phase 3 — start a server-side export and hand the customer the one-hour
 * signed link. There is no query key: each call is a new export and counts
 * toward the workspace's hourly limit, so it is a mutation by design.
 */
export function useServerExport() {
  return useMutation({
    mutationFn: (body: ServerExportRequest) =>
      fetchJson<ServerExportResponse>("/api/customer/exports", {
        method: "POST",
        body,
      }),
    onSuccess: (result) => {
      trackExport("data:export_server", {
        kind: "workspace_answers",
        format: result.format,
        row_count: result.rowCount,
      });
      if (typeof window === "undefined") return;
      window.location.assign(result.url);
      toast.success("Export ready. Your download has started.", {
        action: {
          label: "Open link",
          onClick: () => window.open(result.url, "_blank", "noopener,noreferrer"),
        },
      });
    },
  });
}
