"use client";

// F18 phase 9 — the Shopify crawler-access list and its save/remove
// mutations. The routes are owner-only and gated on the sub-flag; the card
// only renders for an owner, and the warning only reads the list for one.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

/** What the API returns for a saved signature; the values never leave the server. */
export type CrawlerCredential = {
  id: string;
  host: string;
  provider: "shopify";
  createdAt: string;
  expiresAt: string | null;
};

type CrawlerAccessListResponse = {
  credentials: CrawlerCredential[];
};

export type SaveCrawlerAccessInput = {
  host: string;
  signatureInput: string;
  signature: string;
};

export function useCrawlerAccessList(brandKey: string, enabled: boolean) {
  return useQuery<CrawlerAccessListResponse>({
    queryKey: keys.siteAuditCrawlerAccess(brandKey),
    queryFn: () =>
      fetchJson<CrawlerAccessListResponse>(
        withBrand("/api/customer/audit/crawler-access", brandKey),
      ),
    enabled: Boolean(brandKey) && enabled,
  });
}

export function useSaveCrawlerAccess(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation<
    { credential: CrawlerCredential },
    Error,
    SaveCrawlerAccessInput
  >({
    mutationFn: (input) =>
      fetchJson<{ credential: CrawlerCredential }>(
        "/api/customer/audit/crawler-access",
        {
          method: "POST",
          body: { brand_key: brandKey, ...input },
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.siteAuditCrawlerAccess(brandKey),
      }),
  });
}

export function useRemoveCrawlerAccess(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation<{ deleted: true }, Error, string>({
    mutationFn: (id) =>
      fetchJson<{ deleted: true }>(
        withBrand(`/api/customer/audit/crawler-access/${id}`, brandKey),
        { method: "DELETE" },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: keys.siteAuditCrawlerAccess(brandKey),
      }),
  });
}
