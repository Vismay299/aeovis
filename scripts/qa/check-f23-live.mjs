#!/usr/bin/env node
/**
 * F23 report-generation live check (owner-run only, never in CI).
 *
 * Generates one real report from a template through `startReportGeneration`,
 * then runs F22 `runAssistantTurn` with the kickoff message, auto-declining
 * any approval card (no paid lookups). Prints only ids, statuses, costs and
 * sanitiser stats — never report text.
 *
 * Usage (owner-run only, builders NEVER run this with flags):
 *   node --env-file=.env.local scripts/qa/check-f23-live.mjs --brand <key> --template <templateId> --max-spend-usd 0.50
 *
 * Refuses (exit 2) without all three flags, when `reports`, `report_generate`
 * or `assistant` is off for the brand, or when the `assistant.turn` spend
 * control does not admit the brand. Exits 1 unless a report was saved and
 * total turn cost stayed within the ceiling.
 */

import { randomUUID } from "node:crypto";

const CEILING_USD = 0.5;
const POLL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_DECLINES = 6;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--brand") args.brand = argv[++i];
    else if (arg === "--template") args.template = argv[++i];
    else if (arg === "--max-spend-usd") args.maxSpendUsd = argv[++i];
    else throw Object.assign(new Error(`unknown argument: ${arg}`), { code: "invalid_argument" });
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/qa/check-f23-live.mjs --brand <key> --template <templateId> --max-spend-usd 0.50

Options:
  --brand <key>           QA workspace brand key (required)
  --template <templateId> Report template id to generate from (required)
  --max-spend-usd 0.50    Total ceiling in USD, must be exactly 0.50 (required)

Description:
  Owner-run only. Starts a generation with startReportGeneration, runs the
  kickoff turn through runAssistantTurn capped at the ceiling, auto-declines
  any approval card (no paid lookups), and prints only the session id, turn
  statuses and costs, whether a report was saved, its id, size in bytes,
  sanitized.changed and removed tag names. Never prints report text. Exits 1
  unless a report was saved within the ceiling.`);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`F23 live check failed with code: ${error.code ?? "invalid_argument"}`);
  process.exit(2);
}
if (args.help) {
  printHelp();
  process.exit(0);
}

const maxSpend = args.maxSpendUsd === undefined ? NaN : Number(args.maxSpendUsd);
if (!args.brand || !args.template || !Number.isFinite(maxSpend) || maxSpend !== CEILING_USD) {
  console.error("refusing: --brand, --template and --max-spend-usd 0.50 are required");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTurn(admin, sessionId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const { data, error } = await admin
      .from("assistant_turns")
      .select("id,status,stop_reason,steps,cost_usd,cost_known,finished_at")
      .eq("session_id", sessionId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.finished_at) return data;
    if (Date.now() > deadline) throw Object.assign(new Error("turn did not settle in time"), { code: "turn_timeout" });
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Walk stored message parts for a save_report success envelope; metadata only. */
function findSanitizedStats(parts) {
  const stack = [parts];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node && typeof node === "object") {
      const record = node;
      const candidate = record.output ?? record.data;
      if (candidate && typeof candidate === "object" && "sanitized" in candidate) {
        const sanitized = candidate.sanitized;
        if (sanitized && typeof sanitized === "object") {
          return {
            changed: sanitized.changed ?? null,
            removedTags: Array.isArray(sanitized.removedTags) ? sanitized.removedTags : null,
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

async function main() {
  const [{ getSupabaseAdmin }, { isFeatureEnabled }, { startReportGeneration }, { runAssistantTurn }, { decideApproval }] =
    await Promise.all([
      import("../../src/shared/supabase/admin.js"),
      import("../../src/server/features/flags.ts"),
      import("../../src/server/reports/generate.ts"),
      import("../../src/server/assistant/turn.ts"),
      import("../../src/server/assistant/approvals.ts"),
    ]);

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("refusing: a service-role Supabase admin client is required");
    process.exit(2);
  }

  for (const name of ["reports", "report_generate", "assistant"]) {
    if (!(await isFeatureEnabled(name, args.brand))) {
      console.error(`refusing: the ${name} control is off for the brand`);
      process.exit(2);
    }
  }
  const { data: control, error: controlError } = await admin
    .from("paid_feature_controls")
    .select("feature,enabled,mode,brand_allowlist")
    .eq("feature", "assistant.turn")
    .maybeSingle();
  if (controlError || !control?.enabled) {
    console.error("refusing: the assistant.turn spend control is disabled");
    process.exit(2);
  }
  if (control.mode === "allowlist" && !(control.brand_allowlist ?? []).includes(args.brand)) {
    console.error("refusing: the assistant.turn spend control does not admit the brand");
    process.exit(2);
  }

  const { data: membership, error: membershipError } = await admin
    .from("customer_brand_memberships")
    .select("user_id,role,customer_brands!inner(brand_key,display_name,website,website_host,aliases,is_active)")
    .eq("brand_key", args.brand)
    .eq("role", "owner")
    .eq("customer_brands.is_active", true)
    .limit(1)
    .maybeSingle();
  if (membershipError || !membership) {
    throw Object.assign(new Error("QA workspace owner membership unavailable"), { code: "workspace_not_found" });
  }
  const brand = Array.isArray(membership.customer_brands) ? membership.customer_brands[0] : membership.customer_brands;
  if (!brand?.website || !membership.user_id) {
    throw Object.assign(new Error("QA workspace setup incomplete"), { code: "workspace_not_ready" });
  }
  const ws = {
    brandKey: args.brand,
    user: { id: membership.user_id, email: "qa-owner@localhost" },
    role: "owner",
    brand: { ...brand, brandKey: args.brand, role: "owner" },
    admin,
  };

  const { sessionId, path } = await startReportGeneration(ws, { templateId: args.template });
  void path;

  const turnEnv = { ...process.env, ASSISTANT_TURN_MAX_USD: String(CEILING_USD) };
  const newMessageId = () => `live${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;

  async function sendTurn(message) {
    const response = await runAssistantTurn({ ws, sessionId, message }, { env: turnEnv });
    await response.arrayBuffer();
    return waitForTurn(admin, sessionId);
  }

  const turns = [];
  let turn = await sendTurn({ id: newMessageId(), role: "user", parts: [{ type: "text", text: "Start." }], metadata: { kind: "kickoff" } });
  turns.push(turn);

  let declines = 0;
  while (turn.stop_reason === "awaiting_approval" && declines < MAX_DECLINES) {
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
    await decideApproval({ ws, approvalId: approval.id, decision: "decline" });
    declines += 1;
    turn = await sendTurn({
      id: newMessageId(),
      role: "user",
      parts: [{ type: "text", text: "Declined." }],
      metadata: { kind: "approval", approvalId: approval.id },
    });
    turns.push(turn);
  }

  const totalCost = turns.reduce((sum, row) => sum + (row.cost_usd === null ? 0 : Number(row.cost_usd)), 0);
  const costKnown = turns.every((row) => row.cost_known === true);

  const { data: saved, error: savedError } = await admin
    .from("reports")
    .select("id,size_bytes")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (savedError) throw savedError;

  let sanitized = null;
  if (saved) {
    const { data: messages, error: messagesError } = await admin
      .from("assistant_messages")
      .select("parts")
      .eq("session_id", sessionId)
      .eq("role", "assistant")
      .order("seq", { ascending: true });
    if (messagesError) throw messagesError;
    for (const message of messages ?? []) {
      sanitized = findSanitizedStats(message.parts) ?? sanitized;
    }
  }

  const report = {
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
    reportSaved: saved !== null,
    reportId: saved?.id ?? null,
    sizeBytes: saved?.size_bytes ?? null,
    sanitizedChanged: sanitized?.changed ?? null,
    sanitizedRemovedTags: sanitized?.removedTags ?? null,
  };
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (!saved) failures.push("no_report_saved");
  if (!costKnown) failures.push("cost_unknown");
  else if (totalCost > CEILING_USD) failures.push("over_ceiling");
  if (turns[turns.length - 1].status !== "completed") failures.push(`status_${turns[turns.length - 1].status}`);
  if (failures.length > 0) {
    console.error(`F23 live check did not pass: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error && typeof error === "object" && "status" in error && "code" in error) {
    const appError = error;
    console.error(`F23 live check refused with code: ${appError.code}`);
    process.exitCode = 2;
    return;
  }
  const rawCode = error && typeof error.code === "string" ? error.code : "live_check_failed";
  const code = /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : "live_check_failed";
  console.error(`F23 live check failed with code: ${code}`);
  process.exitCode = 1;
});
