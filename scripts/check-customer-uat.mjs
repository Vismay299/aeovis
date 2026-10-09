#!/usr/bin/env node
// Read-only production readiness gate. Never print environment values.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

let client;
try {
  const project = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
  const config = JSON.parse(execFileSync("vercel", ["api",
    `/v9/projects/${project.projectId}/env?decrypt=false&teamId=${project.orgId}`, "--raw"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  // Sensitive Vercel values cannot be downloaded. Check registration only;
  // runtime smoke tests must still verify the credentials after deployment.
  const registered = new Set(config.envs.filter((entry) => entry.target?.includes("production")).map((entry) => entry.key));
  const env = process.env;
  const required = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "GSC_GOOGLE_CLIENT_ID", "GSC_GOOGLE_CLIENT_SECRET", "GSC_OAUTH_REDIRECT_URI", "GSC_TOKEN_ENCRYPTION_KEY",
    "APP_URL", "LLM_API_KEY", "CONTENT_MODEL", "CRON_SECRET", "OPERATOR_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_DB_HOST"];
  const missing = required.filter((name) => !registered.has(name));
  for (const name of missing) console.log(`MISSING ${name}`);
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  client = new pg.Client({ host: env.SUPABASE_DB_HOST,
    port: Number(env.SUPABASE_DB_PORT || 5432), user: env.SUPABASE_DB_USER || `postgres.${ref}`,
    database: "postgres", password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  const { rows } = await client.query("SELECT filename FROM public.schema_migrations");
  const applied = new Set(rows.map((row) => row.filename));
  const pending = ["023_customer_auth_and_tenant_rls.sql", "024_customer_workspace_ownership.sql",
    "025_gsc_customer_oauth.sql", "026_customer_uat_repairs.sql"].filter((file) => !applied.has(file));
  for (const file of pending) console.log(`PENDING ${file}`);
  if (missing.length || pending.length) process.exitCode = 1;
  else console.log("Production variable registration and migration ledger passed. Credential validity still requires live UAT.");
} catch {
  console.error("Could not complete production readiness check. No credentials were printed.");
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
