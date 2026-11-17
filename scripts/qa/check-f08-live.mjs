#!/usr/bin/env node
/**
 * F08 AI question setup and research live check (owner-run only, never in CI).
 *
 * Runs one setup review and one question research request against a loopback QA
 * Supabase/Postgres workspace. The 1.00 USD ceiling is preflighted against both
 * fresh quotes; calls use the loopback spend store and the enabled feature caps.
 * Prints ledger totals only, never review text, answer text, or provider data.
 *
 * Usage:
 *   node scripts/qa/check-f08-live.mjs --max-spend-usd 1.00 --brand <brand-key>
 *   node scripts/qa/check-f08-live.mjs --help
 */

import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--brand") args.brand = argv[++i];
    else if (arg === "--max-spend-usd") args.maxSpendUsd = argv[++i];
    else throw Object.assign(new Error("unknown argument"), { code: "invalid_argument" });
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/qa/check-f08-live.mjs --max-spend-usd 1.00 --brand <brand-key>

Options:
  --help, -h          Print this help message and exit
  --brand <key>       QA workspace brand key (required)
  --max-spend-usd     Total ceiling, must be exactly 1.00 USD

Description:
  Runs one questions.setup review and one questions.research request.
  Requires loopback QA Supabase/Postgres, enabled feature flags, and all three
  questions.setup, questions.generate, and questions.research spend controls.
  Both fresh quotes must fit within the combined 1.00 USD ceiling.
  Prints per-feature ledger totals only. No provider output is printed.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!args.brand || args.maxSpendUsd !== "1.00") {
  console.error("refusing: --brand and --max-spend-usd 1.00 are required");
  process.exit(2);
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

const pgHost = process.env.PGHOST || "127.0.0.1";
const database = process.env.PGDATABASE || "aeovis_live_qa";
if (!isLoopback(pgHost) || !database.endsWith("_qa")) {
  console.error("refusing: a loopback Postgres database ending in _qa is required");
  process.exit(2);
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("refusing: local QA Supabase configuration is required");
  process.exit(2);
}
try {
  const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname;
  if (!isLoopback(supabaseHost)) throw new Error("non-loopback Supabase");
} catch {
  console.error("refusing: Supabase must point to loopback QA");
  process.exit(2);
}

async function main() {
  const [{ Pool }, { createSpendStore }, { getSupabaseAdmin }, { isFeatureEnabled }] = await Promise.all([
    import("pg"),
    import("../../src/shared/spend/store.ts"),
    import("../../src/shared/supabase/admin.js"),
    import("../../src/server/features/flags.ts"),
  ]);
  const pool = new Pool({
    host: pgHost,
    port: Number(process.env.PGPORT || 5432),
    database,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });

  try {
    const admin = getSupabaseAdmin();
    if (!admin) throw Object.assign(new Error("QA admin unavailable"), { code: "qa_admin_unavailable" });

    const spendFeatures = ["questions.setup", "questions.generate", "questions.research"];
    const controls = await pool.query(
      "SELECT feature, enabled, mode, brand_allowlist FROM public.paid_feature_controls WHERE feature = ANY($1::text[])",
      [spendFeatures],
    );
    const controlByFeature = new Map(controls.rows.map((row) => [row.feature, row]));
    for (const feature of spendFeatures) {
      const control = controlByFeature.get(feature);
      if (!control?.enabled) {
        throw Object.assign(new Error("spend control disabled"), { code: "feature_disabled" });
      }
      if (control.mode === "allowlist" && !(control.brand_allowlist || []).includes(args.brand)) {
        throw Object.assign(new Error("brand is not admitted"), { code: "brand_not_allowlisted" });
      }
    }

    for (const flag of ["question_curation", "question_setup", "prompt_research"]) {
      if (!(await isFeatureEnabled(flag, args.brand))) {
        throw Object.assign(new Error("feature flag disabled"), { code: "feature_unavailable" });
      }
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
    const { readQuestionSettings } = await import("../../src/server/questions/workspaceQuestions.ts");
    const settings = await readQuestionSettings(admin, args.brand);
    const pricingContext = { brandKey: args.brand, admin, env: process.env, now: new Date() };

    await import("../../src/shared/pricing/actions/index.ts");
    const { quote, requireApprovedPrice, recordApproval } = await import("../../src/shared/pricing/pricedActions.ts");
    const setupQuote = await quote("questions.setup.run", pricingContext, {});
    const researchQuote = await quote(
      "questions.research.run",
      pricingContext,
      { keyword: settings.researchKeywords?.[0] || "streetwear" },
    );
    if (setupQuote.blocked || researchQuote.blocked) {
      throw Object.assign(new Error("priced action is blocked"), {
        code: setupQuote.blocked?.code || researchQuote.blocked?.code || "action_blocked",
      });
    }
    if (setupQuote.totalUsd + researchQuote.totalUsd > 1.0) {
      throw Object.assign(new Error("combined quotes exceed the ceiling"), { code: "quote_over_ceiling" });
    }

    const setupApproval = await requireApprovedPrice(
      "questions.setup.run",
      pricingContext,
      {},
      setupQuote.totalUsd,
    );
    const researchKeyword = settings.researchKeywords?.[0] || "streetwear";
    const researchApproval = await requireApprovedPrice(
      "questions.research.run",
      pricingContext,
      { keyword: researchKeyword },
      researchQuote.totalUsd,
    );
    const spendStore = createSpendStore({
      rpc: async (name, values) => {
        if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error("invalid spend RPC name");
        const entries = Object.entries(values);
        const sql = `SELECT ${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(",")}) AS result`;
        const result = await pool.query(
          sql,
          entries.map(([, value]) => (value && typeof value === "object" ? JSON.stringify(value) : value)),
        );
        return { data: result.rows[0]?.result, error: null };
      },
    });
    const spendDeps = { store: spendStore, env: process.env, notifyCap: false };
    const { metered } = await import("../../src/shared/spend/index.ts");
    const meterWithQaStore = (input, call) => metered(input, call, spendDeps);
    const { llmObject, llmText } = await import("../../src/server/llm/index.ts");
    const llmObjectWithQaStore = (input) => llmObject(input, { spend: spendDeps, env: process.env });
    const llmTextWithQaStore = (input) => llmText(input, { spend: spendDeps, env: process.env });
    const { createDataforseoClient } = await import("../../src/shared/providers/dataforseo/client.ts");
    const dataforseoClient = createDataforseoClient({ spendDeps });
    const { promptgenCandidates } = await import("../../src/server/questions/setup/promptgenSource.ts");
    const promptgenWithQaStore = (ctx, input) => promptgenCandidates(ctx, input, {
      llmText: llmTextWithQaStore,
      metered: meterWithQaStore,
      env: process.env,
    });

    const { normalizeCompetitorDomain } = await import("../../src/server/questions/setup/research.ts");
    const { country, language } = settings;
    const setupJobId = randomUUID();
    const setupPayload = {
      brandKey: args.brand,
      approvedMaxUsd: setupApproval.approvedMaxUsd,
      requestedBy: membership.user_id,
      website: brand.website,
      ownHost: normalizeCompetitorDomain(brand.website_host || brand.website),
      displayName: brand.display_name,
      market: { country, language },
    };
    await recordApproval(admin, {
      brandKey: args.brand,
      action: "questions.setup.run",
      approvedMaxUsd: setupApproval.approvedMaxUsd,
      quote: setupApproval.quote,
      source: setupApproval.source,
      subject: { kind: "job", id: setupJobId },
      approvedBy: membership.user_id,
    });

    const startedAt = new Date().toISOString();
    const jobContext = {
      jobId: setupJobId,
      brandKey: args.brand,
      payload: setupPayload,
      trigger: "manual",
      step: {
        do: async (_name, options, fn) => {
          if (options.billed === true && options.retries !== 0) {
            throw Object.assign(new Error("paid step retry configuration is unsafe"), { code: "unsafe_step" });
          }
          return fn();
        },
        sleep: async () => {},
      },
      progress: async () => {},
      cancelRequested: async () => false,
    };

    const { runQuestionSetup } = await import("../../src/server/questions/setup/research.ts");
    await runQuestionSetup(jobContext, {
      admin,
      llmObject: llmObjectWithQaStore,
      dataforseoClient,
      metered: meterWithQaStore,
      promptgenCandidates: promptgenWithQaStore,
      env: process.env,
    });

    const requestId = randomUUID();
    await recordApproval(admin, {
      brandKey: args.brand,
      action: "questions.research.run",
      approvedMaxUsd: researchApproval.approvedMaxUsd,
      quote: researchApproval.quote,
      source: researchApproval.source,
      subject: { kind: "request", id: requestId },
      approvedBy: membership.user_id,
    });
    const { researchQuestions } = await import("../../src/server/questions/promptResearch.ts");
    await researchQuestions(
      admin,
      workspace,
      { requestId, keyword: researchKeyword, maxUsd: researchApproval.approvedMaxUsd },
      { dataforseoClient, llmObject: llmObjectWithQaStore },
    );

    const ledger = await pool.query(
      "SELECT feature, cost_source, SUM(accounted_usd)::numeric(10,4) AS total_usd FROM public.spend_ledger WHERE brand_key = $1 AND feature = ANY($2::text[]) AND occurred_at >= $3 GROUP BY feature, cost_source ORDER BY feature, cost_source",
      [args.brand, ["questions.setup", "questions.generate", "questions.research"], startedAt],
    );
    console.log(JSON.stringify({ rows: ledger.rows }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const rawCode = error && typeof error.code === "string" ? error.code : "live_check_failed";
  const code = /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : "live_check_failed";
  console.error(`F08 live check failed with code: ${code}`);
  process.exitCode = 1;
});
