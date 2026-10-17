#!/usr/bin/env node
// Read-only incident evidence. Never prints credentials, provider error bodies,
// customer answers, or prompts. Does not call providers or alter a scan.
import pg from "pg";

const scanId = process.argv[process.argv.indexOf("--scan-id") + 1];
if (!process.argv.includes("--scan-id") || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scanId || "")) {
  console.error("Usage: node --env-file=.env.local scripts/audit-scan-collection.mjs --scan-id <UUID>");
  process.exit(1);
}
const env = process.env;
if (!env.SUPABASE_DB_HOST || !env.SUPABASE_DB_PASSWORD || !env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error("Set SUPABASE_DB_HOST, SUPABASE_DB_PASSWORD, and NEXT_PUBLIC_SUPABASE_URL.");
  process.exit(1);
}
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const client = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: Number(env.SUPABASE_DB_PORT || 5432),
  user: env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  statement_timeout: 10000,
});

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const { rows: scans } = await client.query(`
    SELECT id, brand, url, scanned_at, created_at, visibility_pct,
      prompts_tracked, prompts_mentioned, raw_results->'engines' AS engines
    FROM public.scans WHERE id=$1`, [scanId]);
  if (!scans.length) throw Object.assign(new Error("Scan not found"), { code: "SCAN_NOT_FOUND" });
  const { rows: collection } = await client.query(`
    SELECT engine, count(*)::int AS persisted_pairs,
      count(*) FILTER (WHERE NOT is_branded_query)::int AS non_branded_pairs,
      count(*) FILTER (WHERE answered AND raw->>'error' IS NULL)::int AS answered,
      count(*) FILTER (WHERE raw->>'error' IS NOT NULL)::int AS errors,
      min(created_at) AS first_result_at, max(created_at) AS last_result_at
    FROM public.prompt_results WHERE scan_id=$1 GROUP BY engine ORDER BY engine`, [scanId]);
  const { rows: failures } = await client.query(`
    SELECT engine, CASE
      WHEN raw->>'error' ILIKE '%HTTP 401%' THEN 'credential_rejected'
      WHEN raw->>'error' ILIKE '%key limit exceeded%' THEN 'api_key_spending_limit'
      WHEN raw->>'error' ILIKE '%HTTP 403%' THEN 'access_denied'
      WHEN raw->>'error' ILIKE '%no ready cookies%' THEN 'provider_cookie_pool_unavailable'
      WHEN raw->>'error' ILIKE '%timeout%' OR raw->>'error' ILIKE '%abort%' THEN 'timeout_or_abort'
      WHEN raw->>'error' ILIKE '%HTTP 429%' THEN 'rate_limited'
      ELSE 'other_provider_error' END AS category, count(*)::int AS pairs
    FROM public.prompt_results WHERE scan_id=$1 AND raw->>'error' IS NOT NULL
    GROUP BY engine, category ORDER BY engine, pairs DESC`, [scanId]);
  const { rows: jobs } = await client.query(`
    SELECT id, status, created_at, heartbeat_at, attempts,
      checkpoint->'engines' AS engines, checkpoint->'geo' AS geo,
      checkpoint->'stats'->'cost' AS recorded_cost
    FROM public.scan_jobs WHERE result_id=$1 ORDER BY created_at`, [scanId]);
  const { rows: chunks } = await client.query(`
    SELECT scan_job_id, phase, outcome, reason, probes_attempted,
      probes_succeeded, errors_recovered, started_at, ended_at
    FROM public.scan_runs WHERE scan_job_id IN
      (SELECT id FROM public.scan_jobs WHERE result_id=$1) ORDER BY started_at`, [scanId]);
  console.log(JSON.stringify({ checked_at: new Date().toISOString(), scan: scans[0], collection, failures, jobs, chunks }, null, 2));
} catch (error) {
  // Connection/query messages and provider bodies are deliberately not echoed.
  console.error(`Collection audit failed (${error.code || "UNKNOWN"}). Check database connectivity and scan ID.`);
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end().catch(() => {});
}
