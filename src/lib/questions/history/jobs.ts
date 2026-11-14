import { AppError } from "../../http/appError.ts";
import { enqueueSystemJob, type EnqueueDeps } from "../../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../../jobs/registry.ts";
import { jobStore, type JobStore } from "../../jobs/store.ts";
import { DB_STEP } from "../../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../../supabase/admin.js";
import { linkQuestionAnswers } from "./links.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * F12 §6.2–§6.3 — periodic linking of collected answers to stable questions,
 * plus 395-day retention of the links.
 *
 * Periodic every 300 s → enqueueSystemJob("questions.link", {}, { dedupeKey:
 * "questions.link:" + slot5m }); the job links every active workspace (at
 * most 200) with a `list` step, then one DB_STEP step per workspace.
 * Periodic daily → enqueueSystemJob("questions.links.retention", {}, {
 * dedupeKey: "questions.links.retention:" + YYYY-MM-DD }); the job prunes
 * links older than 395 days in batches of 5000, up to 20 batches.
 *
 * Read-only phase: links are service-role RPCs over stored rows. No provider
 * calls, no answer text in logs.
 */

export const QUESTIONS_LINK_KIND = "questions.link";
export const QUESTIONS_LINKS_RETENTION_KIND = "questions.links.retention";

const LINK_EVERY_SECONDS = 300;
const RETENTION_EVERY_SECONDS = 86_400;
const MAX_LINK_BRANDS = 200;
const LINK_LIMIT = 2000;
export const QUESTIONS_LINKS_PRUNE_LIMIT = 5000;
const PRUNE_MAX_STEPS = 20;
const RETENTION_DAYS = 395;
const DAY_MS = 86_400_000;

export type QuestionLinkJobsDeps = {
  store?: JobStore | null;
  admin?: SupabaseClient | null;
  now?: (() => Date) | null;
  selfContinue?: ((jobId: string) => unknown) | null;
};

let boundStore: JobStore | null = null;
let boundAdmin: SupabaseClient | null = null;
let boundNow: (() => Date) | null = null;
let boundSelfContinue: ((jobId: string) => unknown) | null = null;

const activeStore = (): JobStore => boundStore ?? jobStore();
const activeNow = (): Date => (boundNow ?? (() => new Date()))();

function activeAdmin(): SupabaseClient {
  const admin = boundAdmin ?? getSupabaseAdmin();
  if (!admin) {
    throw new AppError(503, "questions_unavailable", "Workspace storage is unavailable.");
  }
  return admin as unknown as SupabaseClient;
}

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

export function slot5m(now: Date): string {
  return String(Math.floor(now.getTime() / (5 * 60 * 1000)));
}

export function questionLinksRetentionCutoff(now: Date): string {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
}

export async function listActiveLinkBrands(admin: SupabaseClient, limit = MAX_LINK_BRANDS): Promise<string[]> {
  const { data, error } = await admin
    .from("customer_brands")
    .select("brand_key")
    .eq("is_active", true)
    .order("brand_key")
    .limit(limit);
  if (error) throw error;
  return (Array.isArray(data) ? data : [])
    .map((row) => (row as { brand_key?: unknown }).brand_key)
    .filter((key): key is string => typeof key === "string" && key.length > 0);
}

export async function pruneQuestionAnswerLinks(admin: SupabaseClient, before: string, limit: number): Promise<number> {
  const { data, error } = await admin.rpc("prune_question_answer_links", {
    p_before: before,
    p_limit: limit,
  });
  if (error) throw error;
  const pruned = Number(data);
  return Number.isFinite(pruned) ? pruned : 0;
}

export function registerQuestionLinkJobs(deps: QuestionLinkJobsDeps = {}): void {
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("admin" in deps) boundAdmin = deps.admin ?? null;
  if ("now" in deps) boundNow = deps.now ?? null;
  if ("selfContinue" in deps) boundSelfContinue = deps.selfContinue ?? null;

  if (!jobDefined(QUESTIONS_LINK_KIND)) {
    defineJob(
      QUESTIONS_LINK_KIND,
      async (ctx) => {
        const admin = activeAdmin();
        // Listed inside a step so a replay walks the same brands in the same
        // order: `link-n` memo entries are keyed by position, not brand.
        const brands = await ctx.step.do("list", DB_STEP, () => listActiveLinkBrands(admin));
        let linked = 0;
        let n = 0;
        for (const brand of brands) {
          n += 1;
          const result = await ctx.step.do(`link-${n}`, DB_STEP, () =>
            linkQuestionAnswers(admin, brand, { limit: LINK_LIMIT, linkedBy: "periodic" }),
          );
          linked += result.scan + result.explore + result.legacy + result.imported;
        }
        return { result: { linked } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 10 },
    );
  }

  if (!periodicDefined(QUESTIONS_LINK_KIND)) {
    definePeriodic({
      name: QUESTIONS_LINK_KIND,
      everySeconds: LINK_EVERY_SECONDS,
      run: async (now) => {
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (boundSelfContinue) enqueueDeps.selfContinue = boundSelfContinue;
        await enqueueSystemJob(
          QUESTIONS_LINK_KIND,
          {},
          { dedupeKey: `${QUESTIONS_LINK_KIND}:${slot5m(now)}` },
          enqueueDeps,
        );
      },
    });
  }

  if (!jobDefined(QUESTIONS_LINKS_RETENTION_KIND)) {
    defineJob(
      QUESTIONS_LINKS_RETENTION_KIND,
      async (ctx) => {
        const admin = activeAdmin();
        const before = questionLinksRetentionCutoff(activeNow());
        let pruned = 0;
        for (let index = 1; index <= PRUNE_MAX_STEPS; index += 1) {
          const batch = await ctx.step.do(`prune-${index}`, DB_STEP, () =>
            pruneQuestionAnswerLinks(admin, before, QUESTIONS_LINKS_PRUNE_LIMIT),
          );
          pruned += batch;
          if (batch < QUESTIONS_LINKS_PRUNE_LIMIT) break;
        }
        return { result: { pruned } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 10 },
    );
  }

  if (!periodicDefined(QUESTIONS_LINKS_RETENTION_KIND)) {
    definePeriodic({
      name: QUESTIONS_LINKS_RETENTION_KIND,
      everySeconds: RETENTION_EVERY_SECONDS,
      run: async (now) => {
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (boundSelfContinue) enqueueDeps.selfContinue = boundSelfContinue;
        const day = now.toISOString().slice(0, 10);
        await enqueueSystemJob(
          QUESTIONS_LINKS_RETENTION_KIND,
          {},
          { dedupeKey: `${QUESTIONS_LINKS_RETENTION_KIND}:${day}` },
          enqueueDeps,
        );
      },
    });
  }
}

registerQuestionLinkJobs();
