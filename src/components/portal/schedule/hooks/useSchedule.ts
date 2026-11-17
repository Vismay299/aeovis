"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";
import type { CustomerScheduleView } from "@/server/schedules/schedule.contract";
import type { ScheduleInterval, ScheduleTime } from "@/shared/schedule";

export type SaveScheduleInput = {
  brand_key?: string;
  enabled: boolean;
  interval?: ScheduleInterval;
  scheduleTime?: ScheduleTime;
  maxUsd?: number;
};

export function useSchedule(brandKey: string) {
  return useQuery({
    queryKey: keys.schedule(brandKey),
    queryFn: () =>
      fetchJson<CustomerScheduleView>(
        `/api/customer/schedule?brand_key=${encodeURIComponent(brandKey)}`,
      ),
    enabled: Boolean(brandKey),
    staleTime: 0,
  });
}

export function useSaveSchedule(brandKey: string) {
  const queryClient = useQueryClient();
  const queryKey = keys.schedule(brandKey);

  return useMutation({
    // ScheduleSettings reports every failure itself (dialog error, price-changed
    // state, pause toast); the global toast would duplicate it.
    meta: { errorToast: false },
    mutationFn: (body: SaveScheduleInput) =>
      fetchJson<CustomerScheduleView>("/api/customer/schedule", {
        method: "PUT",
        body: { brand_key: brandKey, ...body },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}
