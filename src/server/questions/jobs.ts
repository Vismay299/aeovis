// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiResearchKeywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F08 §6.3 — daily retention for workspace question events.
 *
 * Periodic every 86,400 s → enqueueSystemJob("questions.retention", {}, { dedupeKey: "questions.retention:" + YYYY-MM-DD });
 * step prune (DB_STEP) prune_workspace_question_events(now − 395 days, 5000).
 */

import { AppError } from "../../shared/http/appError.ts";
import { enqueueSystemJob, type EnqueueDeps } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { jobStore, type JobStore } from "../jobs/store.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 395;
const PRUNE_LIMIT = 5_000;

import { registerQuestionsSetupJob } from "./setup/research.ts";

export const QUESTIONS_RETENTION_KIND = "questions.retention";
export const QUESTIONS_SETUP_KIND = "questions.setup";

export type PruneQuestionEvents = (before: string, limit: number) => Promise<number>;

export type QuestionJobsDeps = {
  store?: JobStore | null;
  pruner?: PruneQuestionEvents | null;
  now?: (() => Date) | null;
  selfContinue?: ((jobId: string) => unknown) | null;
};

async function defaultPruneQuestionEvents(before: string, limit: number): Promise<number> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new AppError(503, "questions_unavailable", "Workspace storage is unavailable.");
  }
  const { data, error } = await admin.rpc("prune_workspace_question_events", {
    p_before: before,
    p_limit: limit,
  });
  if (error) {
    throw new AppError(503, "questions_unavailable", "Question events could not be pruned.", {
      cause: error,
    });
  }
  const deleted = Number(data);
  return Number.isFinite(deleted) ? deleted : 0;
}

let boundStore: JobStore | null = null;
let boundPruner: PruneQuestionEvents | null = null;
let boundNow: (() => Date) | null = null;
let boundSelfContinue: ((jobId: string) => unknown) | null = null;

const activeStore = (): JobStore => boundStore ?? jobStore();
const activePruner = (): PruneQuestionEvents => boundPruner ?? defaultPruneQuestionEvents;
const activeNow = (): Date => (boundNow ?? (() => new Date()))();

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

export function questionEventsRetentionCutoff(now: Date): string {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
}

export function registerQuestionJobs(deps: QuestionJobsDeps = {}): void {
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("pruner" in deps) boundPruner = deps.pruner ?? null;
  if ("now" in deps) boundNow = deps.now ?? null;
  if ("selfContinue" in deps) boundSelfContinue = deps.selfContinue ?? null;

  if (!jobDefined(QUESTIONS_RETENTION_KIND)) {
    defineJob(
      QUESTIONS_RETENTION_KIND,
      async (ctx) => {
        const before = questionEventsRetentionCutoff(activeNow());
        const pruned = await ctx.step.do("prune", DB_STEP, () =>
          activePruner()(before, PRUNE_LIMIT)
        );
        return { result: { pruned } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 10 }
    );
  }

  if (!periodicDefined(QUESTIONS_RETENTION_KIND)) {
    definePeriodic({
      name: QUESTIONS_RETENTION_KIND,
      everySeconds: 86_400,
      run: async (now) => {
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (boundSelfContinue) enqueueDeps.selfContinue = boundSelfContinue;
        const day = now.toISOString().slice(0, 10);
        await enqueueSystemJob(
          QUESTIONS_RETENTION_KIND,
          {},
          {
            dedupeKey: `${QUESTIONS_RETENTION_KIND}:${day}`,
          },
          enqueueDeps
        );
      },
    });
  }

  if (!jobDefined(QUESTIONS_SETUP_KIND)) {
    registerQuestionsSetupJob();
  }
}

registerQuestionJobs();
