"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOptimisticMutation } from "@/components/app/hooks/useOptimisticMutation";
import { emailKeys } from "@/lib/query/keys";
import { fetchJson } from "@/lib/query/fetchJson";

export type EmailPreferences = {
  productUpdates: boolean;
  scanResults: boolean;
  scheduleAlerts: boolean;
  spendAlerts: boolean;
  productUpdatesChangedAt: string | null;
  loopsConfigured: boolean;
  loopsSynced?: boolean;
};

export type EmailPreferenceField =
  | "productUpdates"
  | "scanResults"
  | "scheduleAlerts"
  | "spendAlerts";

export type EmailPreferencesSource = "onboarding" | "settings";

export type SaveEmailPreferencesInput = {
  productUpdates?: boolean;
  scanResults?: boolean;
  scheduleAlerts?: boolean;
  spendAlerts?: boolean;
  source: EmailPreferencesSource;
};

export function useEmailPreferences() {
  const queryClient = useQueryClient();
  const queryKey = emailKeys.preferences();

  const query = useQuery({
    queryKey,
    queryFn: () =>
      fetchJson<EmailPreferences>("/api/customer/email/preferences"),
    staleTime: 60_000,
  });

  const saveMutation = useOptimisticMutation<
    SaveEmailPreferencesInput,
    EmailPreferences,
    EmailPreferences
  >({
    mutationFn: (body) =>
      fetchJson<EmailPreferences>("/api/customer/email/preferences", {
        method: "PUT",
        body,
      }),
    queryKey,
    apply: (old, vars) => {
      const next = { ...old };
      if (vars.productUpdates !== undefined)
        next.productUpdates = vars.productUpdates;
      if (vars.scanResults !== undefined) next.scanResults = vars.scanResults;
      if (vars.scheduleAlerts !== undefined)
        next.scheduleAlerts = vars.scheduleAlerts;
      if (vars.spendAlerts !== undefined) next.spendAlerts = vars.spendAlerts;
      return next;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
    // The component toasts the exact F25 copy itself; the shared
    // mutation toast would show the server's message instead.
    meta: { errorToast: false },
  });

  const save = useCallback(
    async (
      field: EmailPreferenceField,
      value: boolean,
      source: EmailPreferencesSource = "settings",
    ) => {
      const body: SaveEmailPreferencesInput = { source };
      body[field] = value;
      await saveMutation.mutateAsync(body);
    },
    [saveMutation],
  );

  return {
    preferences: query.data ?? null,
    loading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    save,
    saving: saveMutation.isPending,
    query,
  };
}
