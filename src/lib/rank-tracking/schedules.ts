// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/scheduledRankChecks.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { devicesCount } from "../../shared/rank-tracking.ts";
import type { Devices } from "../../shared/rank-tracking.ts";

export type AdmissionConfig = { id: string; keywordCount: number; devices: Devices };
export type AdmissionResult = {
  admitted: AdmissionConfig[];
  deferred: AdmissionConfig[];
  unitsStarted: number;
  stoppedByBudget: boolean;
};

/** Admit oldest due configs against the per-tick 1,000 task-unit budget. */
export function admitByUnitBudget(configs: AdmissionConfig[], budget = 1000): AdmissionResult {
  const admitted: AdmissionConfig[] = [];
  const deferred: AdmissionConfig[] = [];
  let unitsStarted = 0;
  let started = 0;
  let stoppedByBudget = false;
  for (const config of configs) {
    const units = config.keywordCount * devicesCount(config.devices);
    if (started > 0 && unitsStarted + units > budget) {
      stoppedByBudget = true;
      deferred.push(config, ...configs.slice(configs.indexOf(config) + 1));
      break;
    }
    admitted.push(config);
    if (units > 0) {
      started++;
      unitsStarted += units;
    }
  }
  return { admitted, deferred, unitsStarted, stoppedByBudget };
}
