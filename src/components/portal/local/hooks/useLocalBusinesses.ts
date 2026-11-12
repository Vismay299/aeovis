"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/query/keys";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import type { SavedBusinessView } from "@/lib/local/businesses";
import type { BusinessProfileView } from "@/lib/local/profile";
import { trackLocalEvent } from "../telemetry";

export type { SavedBusinessView, BusinessProfileView };

export type SaveBusinessInput = {
  role: "own" | "competitor";
  title: string;
  cid?: string;
  placeId?: string;
  latitude?: number;
  longitude?: number;
  locationCode?: number;
  languageCode?: string;
};

export function useLocalBusinesses(brandKey: string) {
  const queryClient = useQueryClient();

  const query = useQuery<{ businesses: SavedBusinessView[] }>({
    queryKey: keys.localBusinesses(brandKey),
    queryFn: () =>
      fetchJson<{ businesses: SavedBusinessView[] }>(
        withBrand("/api/customer/local/businesses", brandKey)
      ),
    enabled: Boolean(brandKey),
  });

  const businesses = query.data?.businesses ?? [];
  const ownBusiness = businesses.find((b) => b.role === "own") ?? null;
  const competitors = businesses.filter((b) => b.role === "competitor");

  const saveMutation = useMutation({
    mutationFn: (input: SaveBusinessInput) =>
      fetchJson<{ business: SavedBusinessView }>(
        withBrand("/api/customer/local/businesses", brandKey),
        {
          method: "POST",
          body: input,
        }
      ),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: keys.localBusinesses(brandKey),
      });
      trackLocalEvent("local:business_saved", { role: variables.role });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({
      businessId,
      role,
    }: {
      businessId: string;
      role: "own" | "competitor";
    }) =>
      fetchJson<{ business: SavedBusinessView }>(
        withBrand(`/api/customer/local/businesses/${businessId}`, brandKey),
        {
          method: "PATCH",
          body: { role },
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: keys.localBusinesses(brandKey),
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (businessId: string) =>
      fetchJson<{ removed: boolean }>(
        withBrand(`/api/customer/local/businesses/${businessId}`, brandKey),
        {
          method: "DELETE",
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: keys.localBusinesses(brandKey),
      });
    },
  });

  const refreshProfileMutation = useMutation({
    mutationFn: ({
      businessId,
      maxUsd,
    }: {
      businessId: string;
      maxUsd?: number;
    }) =>
      fetchJson<{ profile: BusinessProfileView | null }>(
        withBrand(
          `/api/customer/local/businesses/${businessId}/profile`,
          brandKey
        ),
        {
          method: "POST",
          body: {
            maxUsd,
            requestId: crypto.randomUUID(),
          },
        }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: keys.localBusinesses(brandKey),
      });
      trackLocalEvent("local:profile_lookup", { found: Boolean(data.profile) });
    },
  });

  return {
    ...query,
    businesses,
    ownBusiness,
    competitors,
    saveBusiness: saveMutation.mutateAsync,
    isSaving: saveMutation.isPending,
    updateRole: updateRoleMutation.mutateAsync,
    isUpdatingRole: updateRoleMutation.isPending,
    removeBusiness: removeMutation.mutateAsync,
    isRemoving: removeMutation.isPending,
    // The global mutation toast reports a failure; resolve null so the
    // priced buttons' onRun leaves no unhandled rejection.
    refreshProfile: (businessId: string, maxUsd?: number) =>
      refreshProfileMutation.mutateAsync({ businessId, maxUsd }).catch(() => null),
    isRefreshingProfile: refreshProfileMutation.isPending,
  };
}
