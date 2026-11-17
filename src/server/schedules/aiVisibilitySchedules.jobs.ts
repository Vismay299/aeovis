// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/scheduledAiVisibility.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueSystemJob, type EnqueueDeps } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { jobStore, type JobStore } from "../jobs/store.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import {
  listDueCustomerSchedules,
  evaluateScheduledScan,
  startScheduledScan,
  blockScheduledScan,
  type DueCustomerSchedule,
  type ScanStartContext,
  type AiVisibilityScheduleDeps,
} from "./aiVisibilitySchedules.ts";
import { runDueSchedules, type WindowPlan } from "./runDue.ts";

export const SCHEDULES_TICK_KIND = "ai_visibility.schedules.tick";
export const SCHEDULES_PERIODIC_NAME = "ai_visibility.schedules";

export type SchedulesJobsDeps = {
  store?: JobStore | null;
  admin?: SupabaseClient | null;
  now?: (() => Date) | null;
  selfContinue?: ((jobId: string) => unknown) | null;
  scheduleDeps?: AiVisibilityScheduleDeps | null;
  listDue?: ((admin: SupabaseClient, now: Date, limit: number) => Promise<DueCustomerSchedule[]>) | null;
};

let boundStore: JobStore | null = null;
let boundAdmin: SupabaseClient | null = null;
let boundNow: (() => Date) | null = null;
let boundSelfContinue: ((jobId: string) => unknown) | null = null;
let boundScheduleDeps: AiVisibilityScheduleDeps | null = null;
let boundListDue: ((admin: SupabaseClient, now: Date, limit: number) => Promise<DueCustomerSchedule[]>) | null = null;

const activeStore = (): JobStore => boundStore ?? jobStore();
const activeAdmin = (): SupabaseClient => boundAdmin ?? (getSupabaseAdmin() as SupabaseClient);
const activeNow = (): Date => (boundNow ?? (() => new Date()))();

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

export function registerAiVisibilityScheduleJobs(deps: SchedulesJobsDeps = {}): void {
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("admin" in deps) boundAdmin = deps.admin ?? null;
  if ("now" in deps) boundNow = deps.now ?? null;
  if ("selfContinue" in deps) boundSelfContinue = deps.selfContinue ?? null;
  if ("scheduleDeps" in deps) boundScheduleDeps = deps.scheduleDeps ?? null;
  if ("listDue" in deps) boundListDue = deps.listDue ?? null;

  if (!jobDefined(SCHEDULES_TICK_KIND)) {
    defineJob(
      SCHEDULES_TICK_KIND,
      async (ctx) => {
        const admin = activeAdmin();
        const now = activeNow();
        const listFn = boundListDue ?? listDueCustomerSchedules;

        const items = await ctx.step.do("list", DB_STEP, () =>
          listFn(admin, now, 10),
        );

        const scheduleDeps = boundScheduleDeps ?? undefined;

        const result = await runDueSchedules<DueCustomerSchedule, ScanStartContext>({
          items,
          now: now.getTime(),
          evaluate: (item, plan) =>
            evaluateScheduledScan(admin, item, plan, scheduleDeps),
          start: (item, plan, startCtx) =>
            startScheduledScan(admin, item, plan, startCtx, scheduleDeps),
          block: async (item, plan, reason) => {
            await ctx.step.do(`block:${item.key}:${plan.run}`, DB_STEP, () =>
              blockScheduledScan(admin, item, plan, reason, scheduleDeps),
            );
          },
          wrap: (name, fn) =>
            ctx.step.do(name, { timeoutMs: 60_000, retries: 0 }, fn),
        });

        if (result.failed > 0) {
          return { status: "partial", result };
        }
        return { status: "completed", result };
      },
      {
        deadlineSeconds: 240,
        pollAfterSeconds: 20,
        maxInvocations: 10,
      },
    );
  }

  if (!periodicDefined(SCHEDULES_PERIODIC_NAME)) {
    definePeriodic({
      name: SCHEDULES_PERIODIC_NAME,
      everySeconds: 300,
      run: async (now) => {
        const slot = Math.floor(now.getTime() / 300_000);
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (boundSelfContinue) enqueueDeps.selfContinue = boundSelfContinue;

        await enqueueSystemJob(
          SCHEDULES_TICK_KIND,
          { at: now.toISOString() },
          {
            dedupeKey: `${SCHEDULES_PERIODIC_NAME}:${slot}`,
            singleActiveKey: SCHEDULES_PERIODIC_NAME,
          },
          enqueueDeps,
        );
      },
    });
  }
}

export function resetAiVisibilityScheduleJobDeps(): void {
  boundStore = null;
  boundAdmin = null;
  boundNow = null;
  boundSelfContinue = null;
  boundScheduleDeps = null;
  boundListDue = null;
}

registerAiVisibilityScheduleJobs();
