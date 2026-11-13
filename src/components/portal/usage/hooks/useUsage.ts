"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/billing/useBillingUsage.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F03 §6.6.1 — the one read of `GET /api/customer/usage`.
 *
 * The key carries the brand, the range and the time zone, so a viewer who
 * changes any of them gets their own entry instead of another view's answer.
 * No polling: the page is a report, and the server's copy is `no-store`.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import type { WorkspaceUsage } from "@/shared/costs";

export type UsageRange = WorkspaceUsage["range"];

/**
 * The viewer's own IANA zone. The server bins days in it and the limit cards
 * format the reset instant in it, so "today" means the viewer's today.
 */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function useUsage(
  brandKey: string,
  range: UsageRange,
  timeZone: string = viewerTimeZone(),
) {
  return useQuery({
    queryKey: keys.usage(brandKey, range, timeZone),
    queryFn: () =>
      fetchJson<WorkspaceUsage>(
        withBrand("/api/customer/usage", brandKey, { range, tz: timeZone }),
      ),
    enabled: Boolean(brandKey),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
