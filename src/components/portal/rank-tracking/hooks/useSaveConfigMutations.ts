// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/useSaveConfigMutations.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import type { Devices, RankSchedule } from "@/shared/rank-tracking";
import type { ScheduleTime } from "@/shared/schedule";
import { trackRankEvent } from "../telemetry";
import type { RankTrackerSummary } from "./useRankTrackers";

export type SaveConfigInput = {
  domain: string;
  devices: Devices;
  serpDepth: number;
  locationCode: number;
  languageCode: string;
  targetingMode: "national" | "local";
  locationName: string | undefined;
  schedule: RankSchedule;
  scheduleTime: ScheduleTime | undefined;
};

function commonFields(input: SaveConfigInput) {
  return {
    domain: input.domain,
    devices: input.devices,
    serpDepth: input.serpDepth,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    scheduleInterval: input.schedule,
    scheduleTime: input.scheduleTime,
  };
}

export function useSaveConfigMutations({
  brandKey,
  existingConfig,
  onCreated,
  onUpdated,
}: {
  brandKey: string;
  existingConfig?: RankTrackerSummary | null;
  onCreated: (configId: string, tracker: RankTrackerSummary) => void;
  onUpdated: () => void;
}) {
  const client = useQueryClient();

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: keys.rankTrackers(brandKey) });
    if (existingConfig) {
      void client.invalidateQueries({
        queryKey: keys.rankTracker(brandKey, existingConfig.id),
      });
    }
  };

  const createMutation = useMutation({
    mutationFn: (fields: SaveConfigInput) =>
      fetchJson<{ tracker: RankTrackerSummary }>(
        "/api/customer/rank-tracking/configs",
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            ...commonFields(fields),
            locationName:
              fields.targetingMode === "local" ? fields.locationName : undefined,
          },
        },
      ),
    onSuccess: (result) => {
      invalidate();
      trackRankEvent("rank_tracking:config_create", {
        schedule: result.tracker.scheduleInterval,
        devices: result.tracker.devices,
        local: result.tracker.locationName != null,
      });
      onCreated(result.tracker.id, result.tracker);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (fields: SaveConfigInput) => {
      if (!existingConfig) throw new Error("No tracker to update.");
      return fetchJson<{ tracker: RankTrackerSummary }>(
        `/api/customer/rank-tracking/configs/${encodeURIComponent(existingConfig.id)}`,
        {
          method: "PATCH",
          body: {
            brand_key: brandKey,
            ...commonFields(fields),
            // null clears a previously-set local target; undefined would leave
            // the old location_name in the DB and silently keep city targeting.
            locationName:
              fields.targetingMode === "local" ? fields.locationName : null,
          },
        },
      );
    },
    onSuccess: () => {
      invalidate();
      onUpdated();
    },
  });

  return { createMutation, updateMutation };
}
