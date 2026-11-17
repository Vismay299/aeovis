"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

export type Ga4LinkedAccount = {
  grantId: string;
  email: string | null;
  status: "active" | "error";
  linkedAt: string;
  workspaces: number;
};

/** The caller's own linked Google accounts. */
export function useGa4Accounts(brandKey: string) {
  return useQuery({
    queryKey: keys.ga4Accounts(brandKey),
    queryFn: () => fetchJson<{ accounts: Ga4LinkedAccount[] }>(withBrand("/api/customer/ga4/accounts", brandKey)),
    enabled: Boolean(brandKey),
  });
}

export function useRemoveGa4Account(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (grantId: string) =>
      fetchJson<{ removed: boolean; workspacesDisconnected: number }>(
        `/api/customer/ga4/accounts/${encodeURIComponent(grantId)}`,
        { method: "DELETE", body: { brand_key: brandKey, confirmed: true } },
      ),
    onSettled: () => {
      for (const domain of ["ga4Accounts", "ga4Connection", "ga4Properties"]) {
        void queryClient.invalidateQueries({ queryKey: [domain, brandKey] });
      }
    },
  });
}
