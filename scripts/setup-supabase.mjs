#!/usr/bin/env node
/**
 * Apply Supabase schema migrations.
 *
 * Requires one of:
 *   DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres
 *   SUPABASE_DB_PASSWORD=[your database password]
 *
 * Get the password from: Supabase Dashboard → Project Settings → Database → Database password
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getConnectionString() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!password || !url) {
    console.error("\nMissing database credentials.\n");
    console.error("Add one of these to .env.local:\n");
    console.error("  SUPABASE_DB_PASSWORD=your_database_password");
    console.error("  DATABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres\n");
    console.error("Find the password: Supabase Dashboard → Settings → Database → Database password\n");
    process.exit(1);
  }

  const ref = new URL(url).hostname.replace(".supabase.co", "");

  if (process.env.SUPABASE_DB_HOST) {
    const user = process.env.SUPABASE_DB_USER || `postgres.${ref}`;
    const port = process.env.SUPABASE_DB_PORT || "5432";
    return `postgresql://${user}:${encodeURIComponent(password)}@${process.env.SUPABASE_DB_HOST}:${port}/postgres`;
  }

  // Default: session pooler (direct db.* host is not available on all projects)
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const sqlPath = join(__dirname, "../supabase/migrations/001_initial_schema.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const connectionString = getConnectionString();

  console.log("Connecting to Supabase Postgres...");
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log("Applying migration: 001_initial_schema.sql");
    await client.query(sql);
    console.log("Migration applied successfully.\n");

    const tables = ["scans", "brand_prompts", "scan_jobs", "content_events"];
    for (const table of tables) {
      const { rows } = await client.query(
        `SELECT to_regclass('public.${table}') AS regclass`
      );
      const exists = rows[0]?.regclass !== null;
      console.log(`  ${exists ? "✓" : "✗"} public.${table}`);
      if (!exists) process.exitCode = 1;
    }
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();