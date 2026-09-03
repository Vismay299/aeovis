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

import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createHash } from "crypto";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * R6.1.1 — the ledger. Before this, nothing recorded what had been applied.
 *
 * On 2026-08-30 the live database was found to be missing 007, 008 AND 009
 * while `npm run setup:db` would have reported success, because its verify list
 * stopped at 005 and it kept no record of its own runs. A migration runner that
 * cannot say what it applied is not a migration runner.
 */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename         text PRIMARY KEY,
  checksum         text NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  first_applied_at timestamptz
);
-- NULLABLE, and deliberately no default. Rows written before this column
-- existed have an UNKNOWN first-apply time, and backfilling them with now()
-- would claim they first landed on whatever day the column was added. An
-- unknown must read as unknown; that is the whole point of this ledger.
ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS first_applied_at timestamptz;`;

/**
 * What each migration must leave behind, checked against the Postgres catalog.
 *
 * Keyed by migration file so a new migration without an entry fails the guard
 * test in src/lib/migrationsLedger.test.mjs — the stale-list failure (finding
 * C10) was this list silently ending at 005 while four more migrations shipped.
 *
 * `to_regclass` covers tables and indexes; functions need pg_proc, because a
 * table can exist while the function that makes it usable does not — exactly
 * the state 009 was found in.
 */
const EXPECTED_OBJECTS = {
  "001_initial_schema.sql": [
    { kind: "table", name: "scans" },
    { kind: "table", name: "brand_prompts" },
    { kind: "table", name: "scan_jobs" },
    { kind: "table", name: "content_events" },
  ],
  "002_content_os.sql": [
    { kind: "table", name: "content_jobs" },
    { kind: "table", name: "content_items" },
    { kind: "table", name: "content_feedback" },
    { kind: "table", name: "brand_briefs" },
    { kind: "table", name: "content_lessons" },
  ],
  "003_content_agents.sql": [{ kind: "table", name: "content_agents" }],
  "004_crew_canvas_knowledge.sql": [{ kind: "table", name: "knowledge_blocks" }],
  "005_analytics_platform.sql": [
    { kind: "table", name: "prompt_results" },
    { kind: "table", name: "result_brands" },
    { kind: "table", name: "citations" },
    { kind: "table", name: "brand_metrics_daily" },
    { kind: "table", name: "scan_schedules" },
    { kind: "table", name: "topics" },
  ],
  "006_agent_control_plane.sql": [{ kind: "index", name: "content_jobs_heartbeat_idx" }],
  "007_scan_seal.sql": [{ kind: "index", name: "scan_jobs_one_running_per_brand" }],
  "008_system_heartbeats.sql": [{ kind: "table", name: "system_heartbeats" }],
  "009_scan_rate_limit.sql": [
    { kind: "table", name: "scan_rate_limits" },
    { kind: "index", name: "scan_rate_limits_window_idx" },
    { kind: "function", name: "increment_scan_rate_limit" },
  ],
  "010_probe_tasks.sql": [
    { kind: "table", name: "probe_tasks" },
    { kind: "index", name: "probe_tasks_claim_idx" },
    { kind: "index", name: "probe_tasks_batch_idx" },
    { kind: "index", name: "probe_tasks_lease_idx" },
    // The claim IS the migration. A probe_tasks table without
    // claim_probe_tasks is a queue nothing can take work from, and that is
    // exactly the shape 009 was found in — table present, function absent.
    { kind: "function", name: "claim_probe_tasks" },
    { kind: "function", name: "complete_probe_tasks" },
    { kind: "function", name: "renew_probe_lease" },
    { kind: "function", name: "release_probe_tasks" },
  ],
};

async function objectExists(client, { kind, name }) {
  if (kind === "function") {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1`,
      [name]
    );
    return rows.length > 0;
  }
  const { rows } = await client.query("SELECT to_regclass($1) AS regclass", [`public.${name}`]);
  return rows[0]?.regclass !== null;
}

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
  const migrationsDir = join(__dirname, "../supabase/migrations");
  // Apply every .sql migration in filename order (001_, 002_, ...). All
  // migrations are idempotent (IF NOT EXISTS), so re-running is safe.
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const connectionString = getConnectionString();

  console.log("Connecting to Supabase Postgres...");
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    await client.query(SCHEMA_MIGRATIONS_DDL);

    const { rows: recorded } = await client.query(
      "SELECT filename, checksum FROM schema_migrations"
    );
    const priorChecksums = new Map(recorded.map((r) => [r.filename, r.checksum]));

    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      // Hash the NORMALISED text. 001 and 006 are CRLF in the main working
      // tree and LF in any fresh, Linux or CI checkout (.gitattributes pins
      // eol=lf), so hashing raw bytes made setup:db warn that files nobody had
      // touched "had CHANGED" — purely because of where it ran. Normalising
      // line endings and trailing whitespace means the checksum describes the
      // SQL, not the checkout. See R6.4.7 for the mixed-line-endings tree.
      const checksum = createHash("sha256")
        .update(sql.replace(/\r\n/g, "\n").replace(/\s+$/, ""))
        .digest("hex")
        .slice(0, 16);

      // A migration edited AFTER it was applied is a silent schema drift: the
      // file no longer describes the database, and every reader who diffs the
      // two will be misled. Loud, and not fatal — the operator decides.
      const prior = priorChecksums.get(file);
      if (prior && prior !== checksum) {
        console.warn(
          `  ! ${file} has CHANGED since it was applied (${prior} -> ${checksum}). ` +
            `The file no longer describes what is in the database.`
        );
      }

      // One transaction per file. Without this a migration that fails halfway
      // leaves the schema in a state no file describes, and the next run
      // re-applies from the top over that wreckage.
      process.stdout.write(`Applying migration: ${file} ... `);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          // `first_applied_at` is never overwritten, so the ledger keeps when a
          // migration FIRST landed as well as when it was last re-applied.
          // Without it every row carried one timestamp — the last run — and
          // "when did 007 actually reach production" became unanswerable.
          //
          // The checksum is still updated, but only after the mismatch above
          // has been reported: the drift signal used to fire once and then
          // erase its own evidence, leaving the next run silent.
          `INSERT INTO schema_migrations (filename, checksum, applied_at, first_applied_at)
           VALUES ($1, $2, now(), now())
           ON CONFLICT (filename) DO UPDATE SET
             checksum = EXCLUDED.checksum,
             applied_at = now()`,
          [file, checksum]
        );
        await client.query("COMMIT");
        console.log("ok");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.log("FAILED");
        throw new Error(`${file}: ${err.message}`);
      }
    }
    // NOT a success sentence, deliberately. Every file executed; whether the
    // DATABASE is correct is what the next section decides. Saying anything
    // conclusive at this point is how the old runner made a broken run look
    // fine — it printed "Migrations applied successfully." and 17 ticks over a
    // database missing four migrations.
    console.log("\nAll migration files executed. Verifying the result...\n");

    console.log("Verifying schema against the catalog:\n");
    let missing = 0;
    for (const [migration, expectations] of Object.entries(EXPECTED_OBJECTS)) {
      const results = [];
      for (const obj of expectations) {
        const exists = await objectExists(client, obj);
        if (!exists) missing++;
        results.push(`${exists ? "✓" : "✗"} ${obj.kind} ${obj.name}`);
      }
      console.log(`  ${migration}`);
      for (const r of results) console.log(`    ${r}`);
    }

    if (missing > 0) {
      console.error(
        `\n${missing} expected object(s) missing. The database is INCOMPLETE — ` +
          `do not read the "All migration files executed" line above as success.`
      );
      process.exitCode = 1;
    } else {
      console.log("\nAll expected objects present.");
    }
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();