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
 * control does not admit the brand. Exits 1 unless a report was saved, the last
 * turn completed, every cost is known and the TOTAL across all turns stayed
 * within the ceiling (each turn is capped at what is left, not at the ceiling).
 *
 * The logic lives in src/server/reports/liveCheck.ts (unit-tested); this file
 * parses the flags and wires the real database client. The chat it creates is
 * archived afterwards; the report stays at /portal/reports.
 */

const CEILING_USD = 0.5;

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
  kickoff turn through runAssistantTurn, auto-declines any approval card (no
  paid lookups), and prints only the session id, turn statuses and costs,
  whether a report was saved, its id, size in bytes, sanitized.changed and
  removed tag names. Every turn is capped at what is left of the ceiling, so
  the whole run stays within it. Archives the chat it creates; the report
  stays. Never prints report text. Exits 1 unless a report was saved, the last
  turn completed, every cost is known and the total is within the ceiling.`);
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

async function main() {
  const [{ getSupabaseAdmin }, { runReportLiveCheck }, { LiveCheckRefusal }] = await Promise.all([
    import("../../src/shared/supabase/admin.js"),
    import("../../src/server/reports/liveCheck.ts"),
    import("../../src/server/assistant/liveCheck.ts"),
  ]);

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("refusing: a service-role Supabase admin client is required");
    process.exit(2);
  }

  let result;
  try {
    result = await runReportLiveCheck(
      { brand: args.brand, templateId: args.template, maxSpendUsd: maxSpend },
      { admin },
    );
  } catch (error) {
    if (error instanceof LiveCheckRefusal) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }

  console.log(JSON.stringify(result.report, null, 2));
  if (result.failures.length > 0) {
    console.error(`F23 live check did not pass: ${result.failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error && typeof error === "object" && "status" in error && "code" in error) {
    // An AppError from startReportGeneration (feature off, template gone): a refusal, not a failure.
    console.error(`F23 live check refused with code: ${error.code}`);
    process.exitCode = 2;
    return;
  }
  const rawCode = error && typeof error.code === "string" ? error.code : "live_check_failed";
  const code = /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : "live_check_failed";
  console.error(`F23 live check failed with code: ${code}`);
  process.exitCode = 1;
});
