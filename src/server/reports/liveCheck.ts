// F23 §8 P5.T1.S3 — the core of the owner-run report live check. The CLI in
// `scripts/qa/check-f23-live.mjs` parses flags and wires the real database
// client; everything that decides whether the check refuses, how much it may
// spend across all of its turns and whether it passed lives here, so a test can
// drive it without a provider.
//
// It prints and returns ids, names, amounts and sanitiser counts only: never a
// message, a tool payload or any report text.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { decideApproval } from "../assistant/approvals.ts";
import {
  LiveCheckRefusal,
  assertTurnControlAdmits,
  resolveOwnerWorkspace,
} from "../assistant/liveCheck.ts";
import { archiveSession } from "../assistant/sessions.ts";
import { runAssistantTurn, type TurnDeps } from "../assistant/turn.ts";
import { startReportGeneration } from "./generate.ts";

export const REPORT_LIVE_CEILING_USD = 0.5;

/** Approval cards the check will decline before it gives up on the report. */
const MAX_DECLINES = 6;
/** Below this the next turn could not afford a single model call. */
const MIN_TURN_BUDGET_USD = 0.001;
const POLL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;

export type ReportLiveCheckDeps = {
  admin: SupabaseClient;
  isFeatureEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  /** The environment the turns read their configuration from. */
  env?: Record<string, string | undefined>;
  /** Passed through to every turn (tests supply a mock model and a spend store). */
  turnDeps?: TurnDeps;
  startReportGeneration?: typeof startReportGeneration;
  runAssistantTurn?: typeof runAssistantTurn;
  decideApproval?: typeof decideApproval;
  archiveSession?: typeof archiveSession;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  newMessageId?: () => string;
};

export type ReportLiveCheckTurn = {
  id: string;
  status: string;
  stopReason: string | null;
  steps: number;
  cost_usd: number | null;
  cost_known: boolean;
};

export type ReportLiveCheckReport = {
  sessionId: string;
  turns: ReportLiveCheckTurn[];
  approvalsDeclined: number;
  totalCostUsd: number;
  reportSaved: boolean;
  reportId: string | null;
  sizeBytes: number | null;
  sanitizedChanged: boolean | null;
  sanitizedRemovedTags: string[] | null;
};

export type ReportLiveCheckResult = {
  report: ReportLiveCheckReport;
  /** Empty when the check passed: a report was saved, the last turn completed, every cost is known and the total is within the ceiling. */
  failures: string[];
};

type TurnRow = {
  id: string;
  status: string;
  stop_reason: string | null;
  steps: number;
  cost_usd: number | string | null;
  cost_known: boolean;
  finished_at: string | null;
};

/** Walks stored message parts for a `save_report` envelope and returns its sanitiser stats; metadata only. */
export function findSanitizedStats(parts: unknown): { changed: boolean | null; removedTags: string[] | null } | null {
  const stack: unknown[] = [parts];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const candidate = (record.output ?? record.data) as Record<string, unknown> | null | undefined;
      if (candidate && typeof candidate === "object" && "sanitized" in candidate) {
        const sanitized = candidate.sanitized as Record<string, unknown> | null | undefined;
        if (sanitized && typeof sanitized === "object") {
          return {
            changed: typeof sanitized.changed === "boolean" ? sanitized.changed : null,
            removedTags: Array.isArray(sanitized.removedTags)
              ? sanitized.removedTags.filter((tag): tag is string => typeof tag === "string")
              : null,
          };
        }
      }
      for (const value of Object.values(record)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
  }
  return null;
}

/** Whole cents of a cent, so a running total of sub-cent costs does not drift. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Generates one real report from a template for the brand's owner and reports
 * what it cost. Refuses (LiveCheckRefusal) when `reports`, `report_generate` or
 * `assistant` is off for the brand or the `assistant.turn` spend control does not
 * admit it.
 *
 * The ceiling covers the whole check, not each turn. A generation is a kickoff
 * turn plus one more for every approval card the check declines, and each turn
 * reads its own cap from `ASSISTANT_TURN_MAX_USD`; handing every turn the full
 * ceiling would let seven turns spend seven times it. Each turn is therefore
 * started with only what is left, the check stops when nothing useful is left,
 * and it also stops as soon as a turn's cost is unknown, because spend that
 * cannot be measured cannot be kept under a ceiling.
 *
 * Approval cards are always declined: no paid lookups on a live check. It passes
 * only when a report was saved, the last turn completed, every cost is known and
 * the total stayed within the ceiling. The chat it creates is archived afterwards
 * so a check run on a real workspace does not leave a chat in the owner's list;
 * the report stays at `/portal/reports`, which is what the owner shares next.
 */
export async function runReportLiveCheck(
  input: { brand: string; templateId: string; maxSpendUsd: number },
  deps: ReportLiveCheckDeps,
): Promise<ReportLiveCheckResult> {
  const admin = deps.admin;
  const brandKey = input.brand;
  const flag = deps.isFeatureEnabled ?? isFeatureEnabledDefault;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (const name of ["reports", "report_generate", "assistant"] as const) {
    if (!(await flag(name, brandKey))) {
      throw new LiveCheckRefusal(`refusing: the ${name} control is off for the brand`);
    }
  }
  await assertTurnControlAdmits(admin, brandKey);
  const workspace = await resolveOwnerWorkspace(admin, brandKey);

  const { sessionId } = await (deps.startReportGeneration ?? startReportGeneration)(
    workspace,
    { templateId: input.templateId },
    { isFeatureEnabled: flag },
  );

  try {
    const baseEnv = deps.turnDeps?.env ?? deps.env ?? process.env;
    const newMessageId =
      deps.newMessageId ?? (() => `live${now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
    const turns: TurnRow[] = [];
    let spent = 0;
    let costKnown = true;
    let budgetExhausted = false;

    async function waitForTurn(): Promise<TurnRow> {
      const deadline = now() + (deps.pollTimeoutMs ?? POLL_TIMEOUT_MS);
      for (;;) {
        const { data, error } = await admin
          .from("assistant_turns")
          .select("id,status,stop_reason,steps,cost_usd,cost_known,finished_at")
          .eq("session_id", sessionId)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        if ((data as TurnRow | null)?.finished_at) return data as TurnRow;
        if (now() > deadline) {
          throw Object.assign(new Error("turn did not settle in time"), { code: "turn_timeout" });
        }
        await sleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
      }
    }

    /** One turn, capped at what the check has left. Null when nothing useful is left. */
    async function sendTurn(message: Parameters<typeof runAssistantTurn>[0]["message"]): Promise<TurnRow | null> {
      const remaining = roundUsd(input.maxSpendUsd - spent);
      if (remaining < MIN_TURN_BUDGET_USD) {
        budgetExhausted = true;
        return null;
      }
      const response = await (deps.runAssistantTurn ?? runAssistantTurn)(
        { ws: workspace, sessionId, message },
        { ...deps.turnDeps, env: { ...baseEnv, ASSISTANT_TURN_MAX_USD: String(remaining) } },
      );
      await response.arrayBuffer();
      const turn = await waitForTurn();
      turns.push(turn);
      if (turn.cost_known === true && turn.cost_usd !== null) spent = roundUsd(spent + Number(turn.cost_usd));
      else costKnown = false;
      return turn;
    }

    let declines = 0;
    let turn = await sendTurn({
      id: newMessageId(),
      role: "user",
      parts: [{ type: "text", text: "(kickoff)" }],
      metadata: { kind: "kickoff" },
    });
    while (turn && costKnown && turn.stop_reason === "awaiting_approval" && declines < MAX_DECLINES) {
      const { data: approval, error: approvalError } = await admin
        .from("assistant_approvals")
        .select("id")
        .eq("session_id", sessionId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (approvalError) throw approvalError;
      if (!approval) break;
      // No paid lookups on a live check: decline the card and let the assistant continue without it.
      await (deps.decideApproval ?? decideApproval)({
        ws: workspace,
        approvalId: (approval as { id: string }).id,
        decision: "decline",
      });
      declines += 1;
      turn = await sendTurn({
        id: newMessageId(),
        role: "user",
        parts: [{ type: "text", text: "Declined." }],
        metadata: { kind: "approval", approvalId: (approval as { id: string }).id },
      });
    }

    const { data: saved, error: savedError } = await admin
      .from("reports")
      .select("id,size_bytes")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (savedError) throw savedError;
    const savedRow = saved as { id: string; size_bytes: number } | null;

    let sanitized: ReturnType<typeof findSanitizedStats> = null;
    if (savedRow) {
      const { data: messages, error: messagesError } = await admin
        .from("assistant_messages")
        .select("parts")
        .eq("session_id", sessionId)
        .eq("role", "assistant")
        .order("seq", { ascending: true });
      if (messagesError) throw messagesError;
      for (const message of (messages ?? []) as Array<{ parts: unknown }>) {
        sanitized = findSanitizedStats(message.parts) ?? sanitized;
      }
    }

    const report: ReportLiveCheckReport = {
      sessionId,
      turns: turns.map((row) => ({
        id: row.id,
        status: row.status,
        stopReason: row.stop_reason,
        steps: row.steps,
        cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
        cost_known: row.cost_known === true,
      })),
      approvalsDeclined: declines,
      totalCostUsd: spent,
      reportSaved: savedRow !== null,
      reportId: savedRow?.id ?? null,
      sizeBytes: savedRow?.size_bytes ?? null,
      sanitizedChanged: sanitized?.changed ?? null,
      sanitizedRemovedTags: sanitized?.removedTags ?? null,
    };

    const failures: string[] = [];
    if (!savedRow) failures.push("no_report_saved");
    if (!costKnown) failures.push("cost_unknown");
    else if (spent > input.maxSpendUsd) failures.push("over_ceiling");
    const last = turns[turns.length - 1];
    if (!last) failures.push("no_turn_ran");
    else if (last.status !== "completed") failures.push(`status_${last.status}`);
    if (budgetExhausted && !savedRow) failures.push("budget_exhausted");
    return { report, failures };
  } finally {
    // Best effort: a failed archive must not hide the result of the check.
    await (deps.archiveSession ?? archiveSession)(admin, {
      id: sessionId,
      brandKey,
      userId: workspace.user.id,
    }).catch(() => false);
  }
}
