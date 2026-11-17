"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

export type Ga4PickerProperty = {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
  isSelected: boolean;
};

export type Ga4PickerAccount = {
  grantId: string;
  email: string | null;
  requiresReconnect: boolean;
  propertiesUnavailable: boolean;
  properties: Ga4PickerProperty[];
};

/** Owner-only list of every linked account's properties; loaded only while picking. */
export function useGa4Properties(brandKey: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.ga4Properties(brandKey),
    queryFn: () =>
      fetchJson<{ accounts: Ga4PickerAccount[] }>(withBrand("/api/customer/ga4/properties", brandKey)),
    enabled: Boolean(brandKey) && enabled,
    staleTime: 60_000,
  });
}
