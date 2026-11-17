// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/SamChatAgent.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { jobStore } from "../jobs/store.ts";
import type { JobStore } from "../jobs/store.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { interruptStaleTurn } from "./interrupted.ts";

export const MAINTENANCE_INTERVAL_SECONDS = 300;
export const RETENTION_INTERVAL_SECONDS = 86_400;
export const STALE_TURN_SECONDS = 90;
export const MAINTENANCE_TURN_LIMIT = 50;
export const CHUNK_RETENTION_MS = 10 * 60_000;
export const CHUNK_PRUNE_LIMIT = 5_000;
export const SESSION_RETENTION_DAYS = 395;
export const SESSION_PRUNE_LIMIT = 500;
export const SESSION_PRUNE_STEPS = 20;
export { INTERRUPTED_NOTICE } from "./interrupted.ts";

type MaintenanceDeps = {
  admin?: SupabaseClient | null;
  store?: JobStore | null;
  now?: () => Date;
};

let boundAdmin: SupabaseClient | null = null;
let boundStore: JobStore | null = null;

function activeAdmin(): SupabaseClient {
  const admin = boundAdmin ?? getSupabaseAdmin();
  if (!admin) throw new Error("Assistant maintenance has no database client.");
  return admin;
}

type StaleTurn = {
  id: string;
  session_id: string;
  brand_key: string;
};

async function interruptTurn(admin: SupabaseClient, turn: StaleTurn): Promise<boolean> {
  return await interruptStaleTurn(admin, turn);
}

/**
 * §6.3 assistant.maintenance: expire approvals, rebuild interrupted replies
 * (never re-run them) and prune old stream chunks. No paid step, no model call.
 */
export async function runAssistantMaintenance(admin: SupabaseClient, now: Date): Promise<{
  expired: number;
  failed: number;
  interrupted: number;
  chunksDeleted: number;
}> {
  const expiredResult = await admin.rpc("expire_assistant_approvals", { p_now: now.toISOString(), p_limit: 1_000 });
  if (expiredResult.error) throw expiredResult.error;
  const expiry = (expiredResult.data ?? {}) as { expired?: number; failed?: number };

  const cutoff = new Date(now.getTime() - STALE_TURN_SECONDS * 1_000).toISOString();
  const stale = await admin
    .from("assistant_turns")
    .select("id,session_id,brand_key")
    .eq("status", "streaming")
    .lt("heartbeat_at", cutoff)
    .limit(MAINTENANCE_TURN_LIMIT);
  if (stale.error) throw stale.error;
  let interrupted = 0;
  for (const turn of (Array.isArray(stale.data) ? stale.data : []) as StaleTurn[]) {
    if (await interruptTurn(admin, turn)) interrupted += 1;
  }

  const chunkCutoff = new Date(now.getTime() - CHUNK_RETENTION_MS).toISOString();
  const chunks = await admin.rpc("prune_assistant_stream_chunks", {
    p_finished_before: chunkCutoff,
    p_limit: CHUNK_PRUNE_LIMIT,
  });
  if (chunks.error) throw chunks.error;

  return {
    expired: Number(expiry.expired ?? 0),
    failed: Number(expiry.failed ?? 0),
    interrupted,
    chunksDeleted: Number(chunks.data ?? 0),
  };
}

export async function runAssistantRetention(admin: SupabaseClient, now: Date): Promise<{ sessions: number }> {
  const before = new Date(now.getTime() - SESSION_RETENTION_DAYS * 86_400_000).toISOString();
  let sessions = 0;
  for (let index = 1; index <= SESSION_PRUNE_STEPS; index += 1) {
    const { data, error } = await admin.rpc("prune_assistant_sessions", {
      p_before: before,
      p_limit: SESSION_PRUNE_LIMIT,
    });
    if (error) throw error;
    const deleted = Number(data ?? 0);
    sessions += deleted;
    if (deleted < SESSION_PRUNE_LIMIT) break;
  }
  return { sessions };
}

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

/**
 * Registers the two kinds and their periodics. Safe to call twice: the module
 * auto-registers on import, and a test that injects its own database client
 * calls it again to rebind.
 */
export function registerAssistantJobs(deps: MaintenanceDeps = {}): void {
  if ("admin" in deps) boundAdmin = deps.admin ?? null;
  if ("store" in deps) boundStore = deps.store ?? null;
  const store = (): JobStore => boundStore ?? jobStore();

  if (!jobDefined("assistant.maintenance")) {
    defineJob(
      "assistant.maintenance",
      async (ctx) => {
        const result = await ctx.step.do("approvals", DB_STEP, async () => {
          const admin = activeAdmin();
          const now = new Date();
          const expired = await admin.rpc("expire_assistant_approvals", {
            p_now: now.toISOString(),
            p_limit: 1_000,
          });
          if (expired.error) throw expired.error;
          return (expired.data ?? {}) as { expired?: number; failed?: number };
        });

        const turns = await ctx.step.do("turns", DB_STEP, async () => {
          const admin = activeAdmin();
          return await runTurnStep(admin, new Date());
        });

        const chunks = await ctx.step.do("chunks", DB_STEP, async () => {
          const admin = activeAdmin();
          const cutoff = new Date(Date.now() - CHUNK_RETENTION_MS).toISOString();
          const pruned = await admin.rpc("prune_assistant_stream_chunks", {
            p_finished_before: cutoff,
            p_limit: CHUNK_PRUNE_LIMIT,
          });
          if (pruned.error) throw pruned.error;
          return Number(pruned.data ?? 0);
        });

        return {
          result: {
            expired: Number(result.expired ?? 0),
            failed: Number(result.failed ?? 0),
            interrupted: turns,
            chunksDeleted: chunks,
          },
        };
      },
      { deadlineSeconds: 3_600, maxInvocations: 50 },
    );
  }

  if (!jobDefined("assistant.retention")) {
    defineJob(
      "assistant.retention",
      async (ctx) => {
        let sessions = 0;
        for (let index = 1; index <= SESSION_PRUNE_STEPS; index += 1) {
          const deleted = await ctx.step.do(`prune-${index}`, DB_STEP, async () => {
            const admin = activeAdmin();
            const before = new Date(Date.now() - SESSION_RETENTION_DAYS * 86_400_000).toISOString();
            const pruned = await admin.rpc("prune_assistant_sessions", {
              p_before: before,
              p_limit: SESSION_PRUNE_LIMIT,
            });
            if (pruned.error) throw pruned.error;
            return Number(pruned.data ?? 0);
          });
          sessions += deleted;
          if (deleted < SESSION_PRUNE_LIMIT) break;
        }
        return { result: { sessions } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 50 },
    );
  }

  if (!periodicDefined("assistant.maintenance")) {
    definePeriodic({
      name: "assistant.maintenance",
      everySeconds: MAINTENANCE_INTERVAL_SECONDS,
      run: async (now) => {
        await enqueueSystemJob(
          "assistant.maintenance",
          {},
          {
            dedupeKey: "assistant.maintenance:" + Math.floor(now.getTime() / (MAINTENANCE_INTERVAL_SECONDS * 1_000)),
            singleActiveKey: "assistant.maintenance",
          },
          { store: store() },
        );
      },
    });
  }

  if (!periodicDefined("assistant.retention")) {
    definePeriodic({
      name: "assistant.retention",
      everySeconds: RETENTION_INTERVAL_SECONDS,
      run: async (now) => {
        await enqueueSystemJob(
          "assistant.retention",
          {},
          { dedupeKey: "assistant.retention:" + now.toISOString().slice(0, 10) },
          { store: store() },
        );
      },
    });
  }
}

async function runTurnStep(admin: SupabaseClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_TURN_SECONDS * 1_000).toISOString();
  const stale = await admin
    .from("assistant_turns")
    .select("id,session_id,brand_key")
    .eq("status", "streaming")
    .lt("heartbeat_at", cutoff)
    .limit(MAINTENANCE_TURN_LIMIT);
  if (stale.error) throw stale.error;
  let interrupted = 0;
  for (const turn of (Array.isArray(stale.data) ? stale.data : []) as StaleTurn[]) {
    if (await interruptTurn(admin, turn)) interrupted += 1;
  }
  return interrupted;
}

registerAssistantJobs();
