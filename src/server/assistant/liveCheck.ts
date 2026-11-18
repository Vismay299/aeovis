// F22 §8 P6.T1.S2 — the core of the owner-run live check. The CLI in
// `scripts/qa/check-f22-live.mjs` parses flags and wires the real dependencies;
// everything that decides whether the check refuses, how much it may spend and
// whether it passed lives here so a test can drive it without a provider.
//
// It prints and returns amounts, names and codes only: never a message, a tool
// payload, a page or an answer.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { archiveSession, createSession } from "./sessions.ts";
import { runAssistantTurn, type TurnDeps } from "./turn.ts";

export const LIVE_MESSAGE =
  "Use only free tools. Load the seo-coach skill and tell me in two sentences where this workspace stands.";
export const LIVE_CEILING_USD = 0.1;

const POLL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;

/** A reason the check will not start. The CLI exits 2 with the message. */
export class LiveCheckRefusal extends Error {
  readonly code = "refused";
}

export type LiveCheckDeps = {
  admin: SupabaseClient;
  isFeatureEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  /** The environment the turn reads its configuration from. */
  env?: Record<string, string | undefined>;
  /** Passed through to the turn (tests supply a mock model and a spend store). */
  turnDeps?: TurnDeps;
  runAssistantTurn?: typeof runAssistantTurn;
  createSession?: typeof createSession;
  archiveSession?: typeof archiveSession;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  newMessageId?: () => string;
};

export type LiveCheckReport = {
  status: string;
  stopReason: string | null;
  steps: number;
  toolNames: string[];
  skillActivated: string | null;
  cost_usd: number | null;
  cost_known: boolean;
  ledger: Array<{ feature: string; accounted_usd: number; actual_usd: number | null }>;
};

export type LiveCheckResult = {
  report: LiveCheckReport;
  /** Empty when the check passed: completed, cost known, cost within the ceiling. */
  failures: string[];
};

export function toolNamesFromParts(parts: unknown): string[] {
  const names: string[] = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; toolName?: unknown };
    if (typeof record.type !== "string") continue;
    if (record.type.startsWith("tool-")) {
      const name = record.type.slice("tool-".length);
      if (name && !names.includes(name)) names.push(name);
    } else if (record.type === "dynamic-tool" && typeof record.toolName === "string") {
      if (record.toolName && !names.includes(record.toolName)) names.push(record.toolName);
    }
  }
  return names;
}

export function skillFromParts(parts: unknown): string | null {
  let skill: string | null = null;
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; input?: unknown };
    if (record.type !== "tool-activate_skill") continue;
    const input = record.input as { name?: unknown } | null | undefined;
    if (input && typeof input === "object" && typeof input.name === "string" && input.name) {
      skill = input.name;
    }
  }
  return skill;
}

type OwnerRow = {
  user_id: string;
  customer_brands: Record<string, unknown> | Array<Record<string, unknown>> | null;
};

/**
 * Refuses unless the `assistant.turn` spend control is on and admits the brand.
 * Shared by every owner-run live check that runs an assistant turn (F22, F23), so
 * the refusal wording and the allowlist rule cannot drift between them.
 */
export async function assertTurnControlAdmits(admin: SupabaseClient, brandKey: string): Promise<void> {
  const { data: control, error: controlError } = await admin
    .from("paid_feature_controls")
    .select("feature,enabled,mode,brand_allowlist")
    .eq("feature", "assistant.turn")
    .maybeSingle();
  if (controlError || !control?.enabled) {
    throw new LiveCheckRefusal("refusing: the assistant.turn spend control is disabled");
  }
  if (control.mode === "allowlist" && !((control.brand_allowlist as string[] | null) ?? []).includes(brandKey)) {
    throw new LiveCheckRefusal("refusing: the assistant.turn spend control does not admit the brand");
  }
}

/** The brand's owner as a service-role Workspace, the identity a live check runs as. */
export async function resolveOwnerWorkspace(admin: SupabaseClient, brandKey: string): Promise<Workspace> {
  const { data: membership, error: membershipError } = await admin
    .from("customer_brand_memberships")
    .select("user_id,role,customer_brands!inner(brand_key,display_name,website,website_host,aliases,is_active)")
    .eq("brand_key", brandKey)
    .eq("role", "owner")
    .eq("customer_brands.is_active", true)
    .limit(1)
    .maybeSingle();
  const owner = membership as OwnerRow | null;
  if (membershipError || !owner) {
    throw Object.assign(new Error("QA workspace owner membership unavailable"), { code: "workspace_not_found" });
  }
  const brand = Array.isArray(owner.customer_brands) ? owner.customer_brands[0] : owner.customer_brands;
  if (!brand?.website || !owner.user_id) {
    throw Object.assign(new Error("QA workspace setup incomplete"), { code: "workspace_not_ready" });
  }
  return {
    brandKey,
    user: { id: owner.user_id, email: "qa-owner@localhost" },
    role: "owner",
    brand: { ...brand, brandKey, role: "owner" },
    admin,
  } as unknown as Workspace;
}

/**
 * Runs one real turn for the brand's owner and reports what it cost. Refuses
 * (LiveCheckRefusal) when the assistant is not enabled for the brand or its spend
 * control does not admit it.
 *
 * The ceiling is enforced, not just checked afterwards: the turn is started with
 * `ASSISTANT_TURN_MAX_USD` set to it, so the hold the turn reserves and the cost
 * at which it stops itself are the ceiling and not the deployment's default (a
 * $0.50 cap would let a "$0.10" check spend five times that). It passes only when
 * the turn completed, its cost is known and it stayed within the ceiling; a turn
 * that failed before spending (a bad key, a model that cannot call tools) must not
 * read as a pass. The chat it creates is archived afterwards so a check run on a
 * real workspace does not leave a chat in the owner's list.
 */
export async function runLiveCheck(
  input: { brand: string; maxSpendUsd: number },
  deps: LiveCheckDeps,
): Promise<LiveCheckResult> {
  const admin = deps.admin;
  const brandKey = input.brand;
  const flag = deps.isFeatureEnabled ?? isFeatureEnabledDefault;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (!(await flag("assistant", brandKey))) {
    throw new LiveCheckRefusal("refusing: FEATURE_ASSISTANT does not cover the brand");
  }

  await assertTurnControlAdmits(admin, brandKey);
  const workspace = await resolveOwnerWorkspace(admin, brandKey);

  const session = await (deps.createSession ?? createSession)(admin, { brandKey, userId: workspace.user.id });
  try {
    const turnEnv = {
      ...(deps.turnDeps?.env ?? deps.env ?? process.env),
      ASSISTANT_TURN_MAX_USD: String(input.maxSpendUsd),
    };
    const messageId =
      deps.newMessageId?.() ?? `live${now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const response = await (deps.runAssistantTurn ?? runAssistantTurn)(
      {
        ws: workspace,
        sessionId: session.id,
        message: {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: LIVE_MESSAGE }],
          metadata: { kind: "chat", source: "composer" },
        },
      },
      { ...deps.turnDeps, env: turnEnv },
    );
    await response.arrayBuffer();

    type TurnRow = {
      id: string;
      status: string;
      stop_reason: string | null;
      steps: number;
      cost_usd: number | string | null;
      cost_known: boolean;
      finished_at: string | null;
    };
    let turn: TurnRow | null = null;
    const deadline = now() + (deps.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    for (;;) {
      const { data, error } = await admin
        .from("assistant_turns")
        .select("id,status,stop_reason,steps,tool_calls,cost_usd,cost_known,finished_at")
        .eq("session_id", session.id)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if ((data as TurnRow | null)?.finished_at) {
        turn = data as TurnRow;
        break;
      }
      if (now() > deadline) {
        throw Object.assign(new Error("turn did not settle in time"), { code: "turn_timeout" });
      }
      await sleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
    }

    const { data: reply, error: replyError } = await admin
      .from("assistant_messages")
      .select("parts")
      .eq("session_id", session.id)
      .eq("role", "assistant")
      .eq("turn_id", turn.id)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (replyError) throw replyError;
    const parts = (reply as { parts?: unknown } | null)?.parts ?? [];

    // One hold per turn (its idempotency key is the turn id), so one read per hold.
    const { data: holds, error: holdsError } = await admin
      .from("spend_holds")
      .select("id")
      .eq("brand_key", brandKey)
      .eq("feature", "assistant.turn")
      .eq("idempotency_key", `assistant.turn:${turn.id}`);
    if (holdsError) throw holdsError;
    const ledger: LiveCheckReport["ledger"] = [];
    for (const hold of (holds ?? []) as Array<{ id: string }>) {
      const { data: rows, error: ledgerError } = await admin
        .from("spend_ledger")
        .select("feature,accounted_usd,actual_usd")
        .eq("hold_id", hold.id)
        .order("occurred_at", { ascending: true });
      if (ledgerError) throw ledgerError;
      for (const row of (rows ?? []) as Array<{ feature: string; accounted_usd: number | string; actual_usd: number | string | null }>) {
        ledger.push({
          feature: row.feature,
          accounted_usd: Number(row.accounted_usd),
          actual_usd: row.actual_usd === null ? null : Number(row.actual_usd),
        });
      }
    }

    const costUsd = turn.cost_usd === null ? null : Number(turn.cost_usd);
    const report: LiveCheckReport = {
      status: turn.status,
      stopReason: turn.stop_reason,
      steps: turn.steps,
      toolNames: toolNamesFromParts(parts),
      skillActivated: skillFromParts(parts),
      cost_usd: costUsd,
      cost_known: turn.cost_known === true,
      ledger,
    };

    const failures: string[] = [];
    if (report.status !== "completed") failures.push(`status_${report.status}`);
    if (!report.cost_known || costUsd === null) failures.push("cost_unknown");
    else if (costUsd > input.maxSpendUsd) failures.push("over_ceiling");
    return { report, failures };
  } finally {
    // Best effort: a failed archive must not hide the result of the check.
    await (deps.archiveSession ?? archiveSession)(admin, {
      id: session.id,
      brandKey,
      userId: workspace.user.id,
    }).catch(() => false);
  }
}
