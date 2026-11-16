"use client";

import { useEffect, useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { setupKeys } from "@/lib/query/keys";
import type { SetupStep } from "@/shared/setup-steps";

export type SetupStepStatus = "done" | "skipped" | "todo";

/** `GET /api/customer/setup` and `POST /api/customer/setup/dismiss` body. */
export type SetupActivationResponse = {
  brandKey: string;
  steps: Array<{ id: SetupStep; status: SetupStepStatus }>;
};

/**
 * F27 §6.6.9 — the Overview checklist's own state. A workspace-scoped query;
 * `enabled` lets a render test pass a fixture activation through props instead
 * of fetching. A scan that becomes active invalidates the checklist so a row
 * that just completed shows up without a reload.
 */
export function useSetupActivation({
  brandKey,
  enabled = true,
  scanActive = false,
}: {
  brandKey: string;
  enabled?: boolean;
  scanActive?: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: setupKeys.activation(brandKey),
    queryFn: ({ signal }) =>
      fetchJson<SetupActivationResponse>(
        withBrand("/api/customer/setup", brandKey),
        { signal },
      ),
    enabled: enabled && Boolean(brandKey),
    retry: false,
  });

  const sawActiveScan = useRef(false);
  useEffect(() => {
    if (scanActive && !sawActiveScan.current) {
      void queryClient.invalidateQueries({
        queryKey: setupKeys.activation(brandKey),
      });
    }
    sawActiveScan.current = scanActive;
  }, [scanActive, brandKey, queryClient]);

  return query;
}

/**
 * Dismiss or restore one checklist row for the signed-in user. The route
 * answers with the same `{ brandKey, steps }` shape the query reads, so the
 * card updates immediately and then revalidates.
 */
export function useDismissSetupStep(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      step,
      dismissed,
    }: {
      step: SetupStep;
      dismissed: boolean;
    }) =>
      fetchJson<SetupActivationResponse>("/api/customer/setup/dismiss", {
        method: "POST",
        body: { brand_key: brandKey, step, dismissed },
      }),
    onSuccess: async (data) => {
      queryClient.setQueryData(setupKeys.activation(brandKey), data);
      await queryClient.invalidateQueries({
        queryKey: setupKeys.activation(brandKey),
      });
    },
  });
}
