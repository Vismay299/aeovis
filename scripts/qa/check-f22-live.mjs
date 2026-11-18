#!/usr/bin/env node
/**
 * F22 in-app assistant live check (owner-run only, never in CI).
 *
 * Runs one real assistant turn through `runAssistantTurn` with a service-role
 * Workspace for the brand owner and the message "Use only free tools. Load
 * the seo-coach skill and tell me in two sentences where this workspace
 * stands." Prints status, stop reason, steps, tool names called, skill
 * activated, cost and spend-ledger amounts only — never message, tool, page
 * or answer text. Exits 1 when the turn cost exceeds the ceiling.
 *
 * Usage:
 *   node scripts/qa/check-f22-live.mjs --brand <key> --max-spend-usd 0.10
 */

const LIVE_MESSAGE =
  "Use only free tools. Load the seo-coach skill and tell me in two sentences where this workspace stands.";
const CEILING_USD = 0.1;
const TURN_POLL_TIMEOUT_MS = 300_000;
const TURN_POLL_INTERVAL_MS = 2_000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--brand") args.brand = argv[++i];
    else if (arg === "--max-spend-usd") args.maxSpendUsd = argv[++i];
    else throw Object.assign(new Error(`unknown argument: ${arg}`), { code: "invalid_argument" });
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/qa/check-f22-live.mjs --brand <key> --max-spend-usd 0.10

Options:
  --brand <key>        QA workspace brand key (required)
  --max-spend-usd 0.10 Total ceiling in USD, must be exactly 0.10 (required)

Description:
  Owner-run only. Runs one real assistant turn through runAssistantTurn with
  a service-role Workspace for the brand owner, consumes the streamed reply
  to completion, and prints turn status, stop reason, steps, tool names
  called, skill activated, cost_usd, cost_known and the spend-ledger rows for
  assistant.turn:<turnId> (amounts only). Requires FEATURE_ASSISTANT to cover
  the brand and the assistant.turn spend control to admit it. Never prints
  message, tool, page or answer text.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const maxSpend = args.maxSpendUsd === undefined ? NaN : Number(args.maxSpendUsd);
if (!args.brand || !Number.isFinite(maxSpend) || maxSpend !== CEILING_USD) {
  console.error("refusing: --brand and --max-spend-usd 0.10 are required");
  process.exit(2);
}

function refuse(message) {
  console.error(message);
  process.exit(2);
}

function toolNamesFromParts(parts) {
  const names = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object" || typeof part.type !== "string") continue;
    if (part.type.startsWith("tool-")) {
      const name = part.type.slice("tool-".length);
      if (name && !names.includes(name)) names.push(name);
    } else if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
      if (part.toolName && !names.includes(part.toolName)) names.push(part.toolName);
    }
  }
  return names;
}

function skillFromParts(parts) {
  let skill = null;
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object" || part.type !== "tool-activate_skill") continue;
    const input = part.input;
    if (input && typeof input === "object" && typeof input.name === "string" && input.name) {
      skill = input.name;
    }
  }
  return skill;
}

async function main() {
  const [{ getSupabaseAdmin }, { isFeatureEnabled }] = await Promise.all([
    import("../../src/shared/supabase/admin.js"),
    import("../../src/server/features/flags.ts"),
  ]);

  const admin = getSupabaseAdmin();
  if (!admin) refuse("refusing: a service-role Supabase admin client is required");

  if (!(await isFeatureEnabled("assistant", args.brand))) {
    refuse("refusing: FEATURE_ASSISTANT does not cover the brand");
  }

  const { data: control, error: controlError } = await admin
    .from("paid_feature_controls")
    .select("feature,enabled,mode,brand_allowlist")
    .eq("feature", "assistant.turn")
    .maybeSingle();
  if (controlError || !control?.enabled) {
    refuse("refusing: the assistant.turn spend control is disabled");
  }
  if (control.mode === "allowlist" && !(control.brand_allowlist || []).includes(args.brand)) {
    refuse("refusing: the assistant.turn spend control does not admit the brand");
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
    throw Object.assign(new Error("QA workspace owner membership unavailable"), {
      code: "workspace_not_found",
    });
  }
  const brand = Array.isArray(membership.customer_brands)
    ? membership.customer_brands[0]
    : membership.customer_brands;
  if (!brand?.website || !membership.user_id) {
    throw Object.assign(new Error("QA workspace setup incomplete"), { code: "workspace_not_ready" });
  }

  const workspace = {
    brandKey: args.brand,
    user: { id: membership.user_id, email: "qa-owner@localhost" },
    role: "owner",
    brand: { ...brand, brandKey: args.brand, role: "owner" },
    admin,
  };

  const [{ createSession }, { runAssistantTurn }] = await Promise.all([
    import("../../src/server/assistant/sessions.ts"),
    import("../../src/server/assistant/turn.ts"),
  ]);

  const session = await createSession(admin, { brandKey: args.brand, userId: membership.user_id });

  const response = await runAssistantTurn({
    ws: workspace,
    sessionId: session.id,
    message: {
      id: `live${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      role: "user",
      parts: [{ type: "text", text: LIVE_MESSAGE }],
      metadata: { kind: "chat", source: "composer" },
    },
  });
  await response.arrayBuffer();

  let turn = null;
  const deadline = Date.now() + TURN_POLL_TIMEOUT_MS;
  for (;;) {
    const { data, error } = await admin
      .from("assistant_turns")
      .select("id,status,stop_reason,steps,tool_calls,cost_usd,cost_known,finished_at")
      .eq("session_id", session.id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.finished_at) {
      turn = data;
      break;
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error("turn did not settle in time"), { code: "turn_timeout" });
    }
    await new Promise((resolve) => setTimeout(resolve, TURN_POLL_INTERVAL_MS));
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

  const parts = reply?.parts ?? [];
  const toolNames = toolNamesFromParts(parts);
  const skillActivated = skillFromParts(parts);

  const { data: holds, error: holdsError } = await admin
    .from("spend_holds")
    .select("id")
    .eq("brand_key", args.brand)
    .eq("feature", "assistant.turn")
    .eq("idempotency_key", `assistant.turn:${turn.id}`);
  if (holdsError) throw holdsError;
  const holdIds = (holds ?? []).map((hold) => hold.id);
  let ledger = [];
  if (holdIds.length > 0) {
    const { data: rows, error: ledgerError } = await admin
      .from("spend_ledger")
      .select("feature,accounted_usd,actual_usd")
      .in("hold_id", holdIds)
      .order("occurred_at", { ascending: true });
    if (ledgerError) throw ledgerError;
    ledger = (rows ?? []).map((row) => ({
      feature: row.feature,
      accounted_usd: Number(row.accounted_usd),
      actual_usd: row.actual_usd === null ? null : Number(row.actual_usd),
    }));
  }

  const costUsd = turn.cost_usd === null ? null : Number(turn.cost_usd);
  console.log(
    JSON.stringify(
      {
        status: turn.status,
        stopReason: turn.stop_reason,
        steps: turn.steps,
        toolNames,
        skillActivated,
        cost_usd: costUsd,
        cost_known: turn.cost_known,
        ledger,
      },
      null,
      2,
    ),
  );

  if (turn.cost_known && costUsd !== null && costUsd > maxSpend) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  if (process.exitCode === 2) return;
  const rawCode = error && typeof error.code === "string" ? error.code : "live_check_failed";
  const code = /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : "live_check_failed";
  console.error(`F22 live check failed with code: ${code}`);
  process.exitCode = 1;
});
