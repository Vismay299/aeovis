#!/usr/bin/env node
/**
 * F18 site audit live check (owner-run only, never in CI).
 *
 * Starts a 10-page audit of the brand's own website through `startSiteAudit`
 * and waits for completion. Prints status, pages crawled, issue counts per
 * severity, Lighthouse checks and settled spend only — never HTML, page text,
 * tokens or provider bodies.
 *
 * Usage:
 *   node scripts/qa/check-f18-live.mjs --brand <key> --max-spend-usd 0.10 [--lighthouse] [--render]
 */

function parseArgs(argv) {
  const args = { lighthouse: false, render: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--brand") args.brand = argv[++i];
    else if (arg === "--max-spend-usd") args.maxSpendUsd = argv[++i];
    else if (arg === "--lighthouse") args.lighthouse = true;
    else if (arg === "--render") args.render = true;
    else throw Object.assign(new Error(`unknown argument: ${arg}`), { code: "invalid_argument" });
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/qa/check-f18-live.mjs --brand <key> --max-spend-usd <n> [--lighthouse] [--render]

Options:
  --brand <key>        QA workspace brand key (required)
  --max-spend-usd <n>  Total ceiling in USD, must be > 0 and <= 0.10 (required)
  --lighthouse         Also run Lighthouse on the start page only
  --render             Render the 10 pages with Firecrawl

Description:
  Owner-run only. Starts a 10-page audit of the brand's own website through
  startSiteAudit, waits for completion through getAuditStatus, and prints
  status, pages crawled, issue counts per severity, Lighthouse checks and
  settled spend. Requires the relevant paid_feature_controls rows to be enabled
  for the brand. Never prints HTML, page text, tokens or provider bodies.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const maxSpend = args.maxSpendUsd === undefined ? NaN : Number(args.maxSpendUsd);
if (!args.brand || !Number.isFinite(maxSpend) || maxSpend <= 0 || maxSpend > 0.1) {
  console.error("Refusing: pass --brand <key> and --max-spend-usd <n>");
  process.exit(1);
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

async function main() {
  const pgHost = process.env.PGHOST || "127.0.0.1";
  const database = process.env.PGDATABASE || "aeovis_live_qa";
  if (!isLoopback(pgHost) || !String(database).endsWith("_qa")) {
    console.error("Refusing: a loopback Postgres database ending in _qa is required");
    process.exit(2);
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Refusing: local QA Supabase configuration is required");
    process.exit(2);
  }
  try {
    const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname;
    if (!isLoopback(supabaseHost)) throw new Error("non-loopback Supabase");
  } catch {
    console.error("Refusing: Supabase must point to loopback QA");
    process.exit(2);
  }

  const [{ Pool }, { getSupabaseAdmin }, { isFeatureEnabled }] = await Promise.all([
    import("pg"),
    import("../../src/lib/supabase/admin.js"),
    import("../../src/lib/features/flags.ts"),
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

    if (!(await isFeatureEnabled("site_audit", args.brand))) {
      throw Object.assign(new Error("site_audit flag is off"), { code: "feature_unavailable" });
    }
    if (args.lighthouse && !(await isFeatureEnabled("site_audit_lighthouse", args.brand))) {
      throw Object.assign(new Error("lighthouse flag is off"), { code: "feature_disabled" });
    }
    if (args.render && !(await isFeatureEnabled("site_audit_render", args.brand))) {
      throw Object.assign(new Error("render flag is off"), { code: "feature_disabled" });
    }

    const needed = [];
    if (args.lighthouse) needed.push("site_audit.lighthouse");
    if (args.render) needed.push("site_audit.render");
    if (needed.length > 0) {
      const controls = await pool.query(
        "SELECT feature, enabled, mode, brand_allowlist FROM public.paid_feature_controls WHERE feature = ANY($1::text[])",
        [needed],
      );
      const byFeature = new Map(controls.rows.map((row) => [row.feature, row]));
      for (const feature of needed) {
        const control = byFeature.get(feature);
        if (!control?.enabled) {
          throw Object.assign(new Error(`spend control disabled: ${feature}`), { code: "feature_disabled" });
        }
        if (control.mode === "allowlist" && !(control.brand_allowlist || []).includes(args.brand)) {
          throw Object.assign(new Error(`brand is not admitted: ${feature}`), { code: "brand_not_allowlisted" });
        }
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

    await import("../../src/lib/pricing/actions/index.ts");
    const { startSiteAudit, getAuditStatus } = await import("../../src/lib/audit/service.ts");
    const started = await startSiteAudit(
      workspace,
      {
        maxPages: 10,
        lighthouse: Boolean(args.lighthouse),
        renderJavaScript: Boolean(args.render),
        maxUsd: maxSpend,
        trigger: "manual",
      },
    );

    const deadline = Date.now() + 20 * 60_000;
    let status = null;
    for (;;) {
      status = await getAuditStatus(admin, args.brand, started.auditId);
      if (status.status === "queued" || status.status === "running") {
        if (Date.now() > deadline) {
          throw Object.assign(new Error("audit did not finish in time"), { code: "audit_timeout" });
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      break;
    }

    const summary = await pool.query(
      "SELECT severity, count(DISTINCT page_url)::int AS pages FROM public.site_audit_issues WHERE audit_id = $1 GROUP BY severity",
      [started.auditId],
    );
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const row of summary.rows) {
      if (row.severity in counts) counts[row.severity] = Number(row.pages);
    }
    const ledger = await pool.query(
      "SELECT feature, SUM(accounted_usd)::numeric(10,6) AS total_usd FROM public.spend_ledger WHERE brand_key = $1 AND feature = ANY($2::text[]) AND subject_id = $3 GROUP BY feature ORDER BY feature",
      [args.brand, ["site_audit.lighthouse", "site_audit.render"], started.auditId],
    );

    console.log(
      JSON.stringify(
        {
          auditId: started.auditId,
          status: status.status,
          pagesCrawled: status.pagesCrawled,
          pagesTotal: status.pagesTotal,
          issuePages: counts,
          lighthouseCompleted: status.lighthouseCompleted ?? 0,
          lighthouseFailed: status.lighthouseFailed ?? 0,
          settledSpend: ledger.rows,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const rawCode = error && typeof error.code === "string" ? error.code : "live_check_failed";
  const code = /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : "live_check_failed";
  console.error(`F18 live check failed with code: ${code}`);
  process.exitCode = 1;
});
