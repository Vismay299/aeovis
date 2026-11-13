"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";

export type Ga4ConnectionState = {
  connected: boolean;
  configured: boolean;
  canManage: boolean;
  currentUserHasGrant: boolean;
  connectorIsMember: boolean;
  grantStatus: "active" | "error" | null;
  property: {
    id: string;
    displayName: string;
    timeZone: string;
    currencyCode: string;
    accountDisplayName: string | null;
  } | null;
  connectedByEmail: string | null;
  connectedAt: string | null;
};

export function useGa4Connection(brandKey: string) {
  return useQuery({
    queryKey: keys.ga4Connection(brandKey),
    queryFn: () => fetchJson<Ga4ConnectionState>(withBrand("/api/customer/ga4", brandKey)),
    enabled: Boolean(brandKey),
  });
}

/** Drops everything that depends on which property this workspace reads. */
function invalidateGa4(queryClient: ReturnType<typeof useQueryClient>, brandKey: string) {
  for (const domain of ["ga4Connection", "ga4Properties", "ga4Accounts", "ga4Overview", "ga4Report", "ga4Health", "ga4Opportunities"]) {
    void queryClient.invalidateQueries({ queryKey: [domain, brandKey] });
  }
}

export function useSetGa4Property(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // The card shows the refusal inline.
    meta: { errorToast: false },
    mutationFn: (input: { grantId: string; propertyId: string }) =>
      fetchJson<Ga4ConnectionState>("/api/customer/ga4/property", {
        method: "POST",
        body: { brand_key: brandKey, ...input },
      }),
    onSuccess: (state) => {
      queryClient.setQueryData(keys.ga4Connection(brandKey), state);
    },
    onSettled: () => invalidateGa4(queryClient, brandKey),
  });
}

export function useDisconnectGa4(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: () =>
      fetchJson<{ connected: false }>("/api/customer/ga4", {
        method: "DELETE",
        body: { brand_key: brandKey },
      }),
    onSettled: () => invalidateGa4(queryClient, brandKey),
  });
}
