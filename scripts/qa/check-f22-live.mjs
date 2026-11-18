#!/usr/bin/env node
/**
 * F22 in-app assistant live check (owner-run only, never in CI).
 *
 * Runs one real assistant turn through `runAssistantTurn` with a service-role
 * Workspace for the brand owner and the message "Use only free tools. Load
 * the seo-coach skill and tell me in two sentences where this workspace
 * stands." Prints status, stop reason, steps, tool names called, skill
 * activated, cost and spend-ledger amounts only — never message, tool, page
 * or answer text. The turn is capped at the ceiling. Exits 1 unless the turn
 * completed, its cost is known and it stayed within the ceiling.
 *
 * Usage:
 *   node --env-file=.env.local scripts/qa/check-f22-live.mjs --brand <key> --max-spend-usd 0.10
 *
 * The logic lives in src/server/assistant/liveCheck.ts (unit-tested); this file
 * parses the flags and wires the real database client.
 */

const CEILING_USD = 0.1;

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
  a service-role Workspace for the brand owner, capped at the ceiling,
  consumes the streamed reply to completion, and prints turn status, stop
  reason, steps, tool names called, skill activated, cost_usd, cost_known and
  the spend-ledger rows for assistant.turn:<turnId> (amounts only). Requires
  FEATURE_ASSISTANT to cover the brand and the assistant.turn spend control to
  admit it. Exits 1 unless the turn completed with a known cost within the
  ceiling. The chat it creates is archived afterwards. Never prints message,
  tool, page or answer text.`);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`F22 live check failed with code: ${error.code ?? "invalid_argument"}`);
  process.exit(2);
}
if (args.help) {
  printHelp();
  process.exit(0);
}

const maxSpend = args.maxSpendUsd === undefined ? NaN : Number(args.maxSpendUsd);
if (!args.brand || !Number.isFinite(maxSpend) || maxSpend !== CEILING_USD) {
  console.error("refusing: --brand and --max-spend-usd 0.10 are required");
  process.exit(2);
}

async function main() {
  const [{ getSupabaseAdmin }, { runLiveCheck, LiveCheckRefusal }] = await Promise.all([
    import("../../src/shared/supabase/admin.js"),
    import("../../src/server/assistant/liveCheck.ts"),
  ]);

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("refusing: a service-role Supabase admin client is required");
    process.exit(2);
  }

  let result;
  try {
    result = await runLiveCheck({ brand: args.brand, maxSpendUsd: maxSpend }, { admin });
  } catch (error) {
    if (error instanceof LiveCheckRefusal) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }

  console.log(JSON.stringify(result.report, null, 2));
  if (result.failures.length > 0) {
    console.error(`F22 live check did not pass: ${result.failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const rawCode = error && typeof error.code === "string" ? error.code : "live_check_failed";
  const code = /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : "live_check_failed";
  console.error(`F22 live check failed with code: ${code}`);
  process.exitCode = 1;
});
