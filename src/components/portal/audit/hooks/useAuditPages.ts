"use client";

// F18 phase 4 — the pages table, filtered, sorted and paged on the server.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys, stableStringify } from "@/shared/query/keys";

export type AuditPagesFilters = {
  q?: string;
  status?: "all" | "ok" | "redirect" | "error" | "missing";
  fetchClass?: "all" | "ok" | "blocked" | "rate_limited" | "error";
  minWords?: number;
  maxWords?: number;
  minResponseMs?: number;
  maxResponseMs?: number;
  missingAlt?: "all" | "yes" | "no";
  issueType?: string;
  sort?: "url" | "status" | "title" | "h1" | "words" | "images" | "speed";
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
};

export type AuditPageRow = {
  id: string;
  url: string;
  statusCode: number | null;
  fetchClass: "ok" | "blocked" | "rate_limited" | "error";
  redirectUrl: string | null;
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  wordCount: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  responseTimeMs: number | null;
  crawlDepth: number | null;
  inSitemap: boolean;
  isIndexable: boolean;
  structuredDataTypes: string[];
  issueCount: number;
  rendered: boolean;
};

export type AuditPagesResponse = { total: number; rows: AuditPageRow[] };

/** The query string the route accepts: no brand_key, no undefined values. */
export function auditPagesQueryString(filters: AuditPagesFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "" || value === "all") {
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

export function useAuditPages(
  auditId: string,
  filters: AuditPagesFilters,
  enabled: boolean,
) {
  const filtersHash = stableStringify(filters);
  return useQuery<AuditPagesResponse>({
    queryKey: keys.siteAuditPages(auditId, filtersHash),
    queryFn: () => {
      const query = auditPagesQueryString(filters);
      return fetchJson<AuditPagesResponse>(
        `/api/customer/audit/${auditId}/pages${query ? `?${query}` : ""}`,
      );
    },
    enabled: Boolean(auditId) && enabled,
    placeholderData: keepPreviousData,
  });
}
