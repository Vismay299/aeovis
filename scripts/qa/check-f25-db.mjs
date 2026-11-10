#!/usr/bin/env node
/**
 * F25 database harness:
 *   - outbox        (F25-AC-02: dedupe_key uniqueness, data size check constraint)
 *   - claim         (F25-AC-03: concurrency isolation, next_attempt_at filtering, expired claim recovery, attempt count)
 *   - retention     (F25-AC-15: deletion of old sent/skipped/failed rows, retention of pending and recent rows)
 *   - milestones    (F25-AC-09: candidates returned, tolerance of optional tables, workspace_milestones idempotency)
 *   - sweep-scans   (F25-AC-06: scan_finished outbox rows in DB)
 *   - sweep-windows (F25-AC-07: schedule_skipped outbox rows in DB)
 *
 * Runs against a disposable loopback PostgreSQL database that has migrations applied.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f25-db.mjs
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f25-db.mjs --only milestones,sweep-scans,sweep-windows
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sweepScans, sweepWindows } from "../../src/lib/email/sweeps.ts";

const host = process.env.PGHOST || "";
const database = process.env.PGDATABASE || "";
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) ||
  !/(?:_qa|_uat)$/.test(database) ||
  process.env.DATABASE_URL
) {
  throw new Error(
    "F25 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");

const pool = new pg.Pool({ max: 8 });
const id = () => crypto.randomUUID();
const createdUsers = [];
const createdBrands = [];

async function applyMigrations() {
  const m160 = fs.readFileSync(path.join(MIGRATIONS, "160_f25_email_tables.sql"), "utf8");
  const m161 = fs.readFileSync(path.join(MIGRATIONS, "161_f25_email_functions.sql"), "utf8");
  await pool.query(m160);
  await pool.query(m161);
}

async function createUser(label) {
  const userId = id();
  await pool.query(
    "INSERT INTO auth.users(id, email, email_confirmed_at) VALUES ($1, $2, now())",
    [userId, `qa-f25-${label}-${userId}@example.test`],
  );
  createdUsers.push(userId);
  return userId;
}

function createServiceClient(pgPool) {
  return {
    from(table) {
      const filters = [];
      const values = [];
      let selectFields = "*";
      let limitCount = null;
      let orderClause = "";

      const b = {
        select(f) {
          selectFields = f;
          return b;
        },
        eq(col, val) {
          values.push(val);
          filters.push(`"${col}" = $${values.length}`);
          return b;
        },
        in(col, vals) {
          values.push(vals);
          filters.push(`"${col}" = ANY($${values.length})`);
          return b;
        },
        not(col, op, val) {
          if (op === "is" && val === null) {
            filters.push(`"${col}" IS NOT NULL`);
          }
          return b;
        },
        gte(col, val) {
          values.push(val);
          filters.push(`"${col}" >= $${values.length}`);
          return b;
        },
        order(col, opts) {
          orderClause = ` ORDER BY "${col}" ${opts?.ascending ? "ASC" : "DESC"}`;
          return b;
        },
        limit(n) {
          limitCount = n;
          return {
            then(resolve, reject) {
              b.then(resolve, reject);
            },
          };
        },
        maybeSingle() {
          limitCount = 1;
          // b.then is a callback-style thenable that returns nothing, so wrap it in a real Promise.
          return new Promise((resolve, reject) => b.then(resolve, reject)).then((res) => ({
            data: res.data?.[0] ?? null,
            error: res.error,
          }));
        },
        then(resolve, reject) {
          let sql = `SELECT ${selectFields} FROM public.${table}`;
          if (filters.length > 0) sql += " WHERE " + filters.join(" AND ");
          if (orderClause) sql += orderClause;
          if (limitCount !== null) sql += ` LIMIT ${limitCount}`;
          pgPool
            .query(sql, values)
            .then((r) => resolve({ data: r.rows, error: null }))
            .catch((err) => resolve({ data: null, error: err }));
        },
        upsert(rows, opts) {
          // supabase-js builders are thenables that also chain .select(); an async method can't do both.
          const p = b._upsert(rows, opts);
          return { select: () => p, then: (resolve, reject) => p.then(resolve, reject) };
        },
        async _upsert(rows, opts) {
          const list = Array.isArray(rows) ? rows : [rows];
          const inserted = [];
          for (const row of list) {
            const cols = Object.keys(row);
            const vals = Object.values(row);
            const placeholders = vals.map((_, i) => `$${i + 1}`);
            let sql = `INSERT INTO public.${table} ("${cols.join('","')}") VALUES (${placeholders.join(",")})`;
            if (opts?.onConflict) {
              sql += ` ON CONFLICT (${opts.onConflict}) DO NOTHING`;
            }
            sql += " RETURNING id";
            try {
              const res = await pgPool.query(
                sql,
                vals.map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)),
              );
              if (res.rows.length > 0) inserted.push(res.rows[0]);
            } catch (err) {
              return { data: null, error: err };
            }
          }
          return { data: inserted, error: null };
        },
        async insert(rows) {
          return b.upsert(rows);
        },
      };
      return b;
    },
    async rpc(fn, params) {
      try {
        const res = await pgPool.query(`SELECT * FROM public.${fn}($1)`, [params?.p_limit ?? 500]);
        return { data: res.rows, error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    },
  };
}

let onlyGroups = null;
const onlyIdx = process.argv.indexOf("--only");
if (onlyIdx !== -1 && process.argv[onlyIdx + 1]) {
  onlyGroups = new Set(
    process.argv[onlyIdx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
const groupIdx = process.argv.indexOf("--group");
if (groupIdx !== -1 && process.argv[groupIdx + 1]) {
  onlyGroups = new Set([process.argv[groupIdx + 1].trim()]);
}

async function runTest(name, fn) {
  if (onlyGroups && !onlyGroups.has(name)) {
    return;
  }
  await fn();
  console.log(`PASS ${name}`);
}

async function main() {
  try {
    await applyMigrations();

    // 1. Group outbox (F25-AC-02)
    await runTest("outbox", async () => {
      const userId = await createUser("outbox");
      const dedupeKey = `qa-dedupe-${id()}`;

      // Insert first row
      const res1 = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, data)
         VALUES ('transactional', 'scan_finished', $1, $2, '{"scanId": "s1"}')
         RETURNING id`,
        [userId, dedupeKey],
      );
      assert.equal(res1.rowCount, 1, "first insert succeeds");

      // Insert duplicate key with ON CONFLICT DO NOTHING leaves one row
      const res2 = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, data)
         VALUES ('transactional', 'scan_finished', $1, $2, '{"scanId": "s1"}')
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [userId, dedupeKey],
      );
      assert.equal(res2.rowCount, 0, "duplicate insert with ON CONFLICT DO NOTHING returns 0 rows");

      // Raw duplicate insert throws unique violation (23505)
      await assert.rejects(
        pool.query(
          `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, data)
           VALUES ('transactional', 'scan_finished', $1, $2, '{"scanId": "s1"}')`,
          [userId, dedupeKey],
        ),
        (err) => err.code === "23505",
        "duplicate dedupe_key must violate unique constraint",
      );

      const countRes = await pool.query(
        `SELECT count(*)::int AS cnt FROM public.email_outbox WHERE dedupe_key = $1`,
        [dedupeKey],
      );
      assert.equal(countRes.rows[0].cnt, 1, "exactly one row remains in email_outbox");

      // 5 KB data -> check violation (23514)
      const hugeData = JSON.stringify({ payload: "x".repeat(5000) });
      await assert.rejects(
        pool.query(
          `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, data)
           VALUES ('transactional', 'scan_finished', $1, $2, $3::jsonb)`,
          [userId, `qa-huge-${id()}`, hugeData],
        ),
        (err) => err.code === "23514",
        "data > 4KB must violate check constraint",
      );

      // Non-object data -> check violation (23514)
      await assert.rejects(
        pool.query(
          `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, data)
           VALUES ('transactional', 'scan_finished', $1, $2, '["not", "an", "object"]'::jsonb)`,
          [userId, `qa-array-${id()}`],
        ),
        (err) => err.code === "23514",
        "non-object data must violate check constraint",
      );

      // Leave nothing due behind: the claim group counts every due row.
      await pool.query(`DELETE FROM public.email_outbox WHERE user_id = $1`, [userId]);
    });

    // 2. Group claim (F25-AC-03)
    await runTest("claim", async () => {
      const userId = await createUser("claim");

      // Seed 15 due rows
      for (let i = 0; i < 15; i++) {
        await pool.query(
          `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, next_attempt_at, attempts)
           VALUES ('transactional', 'scan_finished', $1, $2, 'pending', now() - interval '1 minute', 0)`,
          [userId, `qa-claim-due-${id()}`],
        );
      }

      // Two pool clients call claim_email_outbox(10, owner) concurrently
      const [c1, c2] = await Promise.all([
        pool.query("SELECT * FROM public.claim_email_outbox(10, 'owner-a')"),
        pool.query("SELECT * FROM public.claim_email_outbox(10, 'owner-b')"),
      ]);

      const ids1 = c1.rows.map((r) => r.id);
      const ids2 = c2.rows.map((r) => r.id);
      const combined = [...ids1, ...ids2];

      assert.equal(combined.length, 15, "total claimed rows across both clients must be 15");
      assert.equal(new Set(combined).size, 15, "concurrent claim returned disjoint sets");
      assert.ok(c1.rowCount <= 10 && c1.rowCount >= 5, "client 1 got between 5 and 10 rows");
      assert.ok(c2.rowCount <= 10 && c2.rowCount >= 5, "client 2 got between 5 and 10 rows");

      for (const row of [...c1.rows, ...c2.rows]) {
        assert.equal(row.status, "sending");
        assert.equal(row.attempts, 1);
        assert.ok(row.claimed_until !== null);
      }

      // A future next_attempt_at is not claimed
      const futureRes = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, next_attempt_at, attempts)
         VALUES ('transactional', 'scan_finished', $1, $2, 'pending', now() + interval '10 minutes', 0)
         RETURNING id`,
        [userId, `qa-claim-future-${id()}`],
      );
      const futureId = futureRes.rows[0].id;

      const claimFuture = await pool.query("SELECT * FROM public.claim_email_outbox(10, 'owner-c')");
      const claimedFutureIds = claimFuture.rows.map((r) => r.id);
      assert.ok(!claimedFutureIds.includes(futureId), "future next_attempt_at row is not claimed");

      // An expired 'sending' claim is re-claimed, attempts increments
      const expiredRes = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, claimed_by, claimed_until, attempts)
         VALUES ('transactional', 'scan_finished', $1, $2, 'sending', 'old-owner', now() - interval '1 minute', 1)
         RETURNING id`,
        [userId, `qa-claim-expired-${id()}`],
      );
      const expiredId = expiredRes.rows[0].id;

      const reclaimRes = await pool.query("SELECT * FROM public.claim_email_outbox(10, 'owner-reclaim')");
      const reclaimedRow = reclaimRes.rows.find((r) => r.id === expiredId);
      assert.ok(reclaimedRow, "expired sending claim must be re-claimed");
      assert.equal(reclaimedRow.status, "sending");
      assert.equal(reclaimedRow.claimed_by, "owner-reclaim");
      assert.equal(reclaimedRow.attempts, 2, "attempts must increment on re-claim");
    });

    // 3. Group retention (F25-AC-15)
    await runTest("retention", async () => {
      const userId = await createUser("retention");

      // Seed pending row updated 100 days ago
      const resPending = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, updated_at)
         VALUES ('transactional', 'scan_finished', $1, $2, 'pending', now() - interval '100 days')
         RETURNING id`,
        [userId, `qa-ret-pending-${id()}`],
      );
      const idPending = resPending.rows[0].id;

      // Seed sent row updated 100 days ago
      const resSentOld = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, sent_at, updated_at)
         VALUES ('transactional', 'scan_finished', $1, $2, 'sent', now() - interval '100 days', now() - interval '100 days')
         RETURNING id`,
        [userId, `qa-ret-sent-old-${id()}`],
      );
      const idSentOld = resSentOld.rows[0].id;

      // Seed skipped row updated 100 days ago
      const resSkippedOld = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, updated_at)
         VALUES ('transactional', 'scan_finished', $1, $2, 'skipped', now() - interval '100 days')
         RETURNING id`,
        [userId, `qa-ret-skipped-old-${id()}`],
      );
      const idSkippedOld = resSkippedOld.rows[0].id;

      // Seed failed row updated 100 days ago
      const resFailedOld = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, updated_at)
         VALUES ('transactional', 'scan_finished', $1, $2, 'failed', now() - interval '100 days')
         RETURNING id`,
        [userId, `qa-ret-failed-old-${id()}`],
      );
      const idFailedOld = resFailedOld.rows[0].id;

      // Seed recent sent row updated 10 days ago
      const resSentRecent = await pool.query(
        `INSERT INTO public.email_outbox (kind, template, user_id, dedupe_key, status, sent_at, updated_at)
         VALUES ('transactional', 'scan_finished', $1, $2, 'sent', now() - interval '10 days', now() - interval '10 days')
         RETURNING id`,
        [userId, `qa-ret-sent-rec-${id()}`],
      );
      const idSentRecent = resSentRecent.rows[0].id;

      // Prune rows older than 90 days
      const pruneRes = await pool.query(
        `SELECT public.prune_email_outbox(now() - interval '90 days', 1000) AS pruned`,
      );
      assert.ok(pruneRes.rows[0].pruned >= 3, "pruned at least the 3 old finished rows");

      // Verify pending row is kept
      const checkPending = await pool.query(
        "SELECT id FROM public.email_outbox WHERE id = $1",
        [idPending],
      );
      assert.equal(checkPending.rowCount, 1, "pending row must be kept");

      // Verify recent sent row is kept
      const checkRecent = await pool.query(
        "SELECT id FROM public.email_outbox WHERE id = $1",
        [idSentRecent],
      );
      assert.equal(checkRecent.rowCount, 1, "recent sent row must be kept");

      // Verify old finished rows are deleted
      const checkOld = await pool.query(
        "SELECT id FROM public.email_outbox WHERE id = ANY($1::uuid[])",
        [[idSentOld, idSkippedOld, idFailedOld]],
      );
      assert.equal(checkOld.rowCount, 0, "old finished rows must be deleted");
    });

    // 4. Group milestones (F25-AC-09)
    await runTest("milestones", async () => {
      const user = await createUser("milestones");
      const brandKey = `qa-brand-${id()}`;
      createdBrands.push(brandKey);

      await pool.query(
        `INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, is_active)
         VALUES ($1, 'Milestones Brand', 'https://example.test', 'example.test', true)`,
        [brandKey],
      );
      await pool.query(
        `INSERT INTO public.customer_brand_memberships (brand_key, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [brandKey, user],
      );

      // Seed a scan
      const scanId = id();
      await pool.query(
        `INSERT INTO public.scans (id, brand, brand_key, created_at) VALUES ($1, $2, $2, now())`,
        [scanId, brandKey],
      );

      // Seed an enabled OAuth GSC connection
      await pool.query(
        `INSERT INTO public.gsc_connections (brand, brand_key, site_url, enabled, auth_mode, updated_at)
         VALUES ($1, $1, 'https://example.test', true, 'oauth', now())`,
        [brandKey],
      );

      // Seed an approved draft
      await pool.query(
        `INSERT INTO public.content_items (brand, playbook, status, updated_at)
         VALUES ($1, 'geo_article', 'approved', now())`,
        [brandKey],
      );

      // Call email_milestone_candidates
      const initialCand = await pool.query(
        "SELECT * FROM public.email_milestone_candidates(500) WHERE brand_key = $1",
        [brandKey],
      );

      const returnedMilestones = initialCand.rows.map((r) => r.milestone);
      assert.ok(returnedMilestones.includes("workspace_created"), "workspace_created candidate");
      assert.ok(returnedMilestones.includes("first_scan_completed"), "first_scan_completed candidate");
      assert.ok(returnedMilestones.includes("gsc_connected"), "gsc_connected candidate");
      assert.ok(returnedMilestones.includes("draft_approved"), "draft_approved candidate");

      // Insert them into workspace_milestones
      for (const row of initialCand.rows) {
        await pool.query(
          `INSERT INTO public.workspace_milestones (brand_key, milestone, reached_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (brand_key, milestone) DO NOTHING`,
          [row.brand_key, row.milestone, row.reached_at],
        );
      }

      // After inserting, none returned
      const afterInsert = await pool.query(
        "SELECT * FROM public.email_milestone_candidates(500) WHERE brand_key = $1",
        [brandKey],
      );
      const remainingMilestones = afterInsert.rows.filter((r) =>
        ["workspace_created", "first_scan_completed", "gsc_connected", "draft_approved"].includes(r.milestone),
      );
      assert.equal(remainingMilestones.length, 0, "inserted milestones must not be returned again");

      // Create stub tables only when absent
      const createdTables = [];
      const hasSchedulesRes = await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'scan_schedules'",
      );
      if (hasSchedulesRes.rowCount === 0) {
        await pool.query(
          `CREATE TABLE public.scan_schedules (
            brand text PRIMARY KEY,
            managed_by text,
            enabled boolean,
            customer_updated_at timestamptz,
            updated_at timestamptz
          )`,
        );
        createdTables.push("scan_schedules");
      }

      const hasAuditsRes = await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'site_audits'",
      );
      if (hasAuditsRes.rowCount === 0) {
        await pool.query(
          `CREATE TABLE public.site_audits (
            brand_key text,
            status text,
            completed_at timestamptz
          )`,
        );
        createdTables.push("site_audits");
      }

      const hasTurnsRes = await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'assistant_turns'",
      );
      if (hasTurnsRes.rowCount === 0) {
        await pool.query(
          `CREATE TABLE public.assistant_turns (
            brand_key text,
            status text,
            created_at timestamptz
          )`,
        );
        createdTables.push("assistant_turns");
      }

      // Seed one row each in the stub tables
      await pool.query(
        `INSERT INTO public.scan_schedules (brand, display_name, cadence, managed_by, schedule_interval, approved_max_usd, enabled, customer_updated_at, updated_at)
         VALUES ($1, $1, 'daily', 'customer', 'daily', 1, true, now(), now())
         ON CONFLICT (brand) DO UPDATE SET managed_by = 'customer', schedule_interval = 'daily', approved_max_usd = 1, enabled = true`,
        [brandKey],
      );
      await pool.query(
        `INSERT INTO public.site_audits (brand_key, requested_url, start_url, start_host, max_pages, status, completed_at)
         VALUES ($1, 'https://' || $1 || '/', 'https://' || $1 || '/', $1, 50, 'completed', now())`,
        [brandKey],
      );
      await pool.query(
        `INSERT INTO public.assistant_turns (brand_key, status, created_at)
         VALUES ($1, 'completed', now())`,
        [brandKey],
      );

      const stubCand = await pool.query(
        "SELECT * FROM public.email_milestone_candidates(500) WHERE brand_key = $1",
        [brandKey],
      );
      const stubMilestones = stubCand.rows.map((r) => r.milestone);
      assert.ok(stubMilestones.includes("schedule_set"), "schedule_set candidate returned");
      assert.ok(stubMilestones.includes("audit_run"), "audit_run candidate returned");
      assert.ok(stubMilestones.includes("assistant_used"), "assistant_used candidate returned");

      // Drop any created stub tables to prove tolerance of their absence
      for (const tbl of createdTables) {
        await pool.query(`DROP TABLE IF EXISTS public.${tbl} CASCADE`);
      }

      // Run once with stubs dropped/absent to prove function tolerates absence
      const tolCand = await pool.query(
        "SELECT * FROM public.email_milestone_candidates(500) WHERE brand_key = $1",
        [brandKey],
      );
      assert.ok(Array.isArray(tolCand.rows), "email_milestone_candidates succeeds when optional tables are absent");
    });

    // 5. Group sweep-scans (F25-AC-06 DB)
    await runTest("sweep-scans", async () => {
      const user = await createUser("sweep-scans");
      const brandKey = `qa-brand-${id()}`;
      createdBrands.push(brandKey);

      await pool.query(
        `INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, is_active)
         VALUES ($1, 'Sweep Scans Brand', 'https://example.test', 'example.test', true)`,
        [brandKey],
      );
      await pool.query(
        `INSERT INTO public.customer_brand_memberships (brand_key, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [brandKey, user],
      );
      await pool.query(
        `INSERT INTO public.user_email_preferences (user_id, scan_results, schedule_alerts, spend_alerts, product_updates)
         VALUES ($1, true, true, true, false)
         ON CONFLICT (user_id) DO UPDATE SET scan_results = true`,
        [user],
      );

      const scanId = id();
      await pool.query(
        `INSERT INTO public.scans (id, brand, brand_key, created_at, prompts_tracked, prompts_mentioned, raw_results)
         VALUES ($1, $2, $2, now(), 10, 5, '{"summary_stats": {"terminal_outcome": {"outcome": "complete"}}}'::jsonb)`,
        [scanId, brandKey],
      );

      const serviceClient = createServiceClient(pool);
      const res = await sweepScans(serviceClient, new Date(), { appUrl: "https://app.example.test" });
      assert.ok(res.scans >= 1, "found at least 1 scan");

      // Assert outbox row was inserted in PostgreSQL
      const outboxRes = await pool.query(
        `SELECT * FROM public.email_outbox WHERE dedupe_key = $1`,
        [`scan_finished:${scanId}:${user}`],
      );
      assert.equal(outboxRes.rowCount, 1, "outbox row must be inserted in DB");
      assert.equal(outboxRes.rows[0].template, "scan_finished");
      assert.equal(outboxRes.rows[0].user_id, user);
      assert.equal(outboxRes.rows[0].status, "pending");
    });

    // 6. Group sweep-windows (F25-AC-07 DB)
    await runTest("sweep-windows", async () => {
      const user = await createUser("sweep-windows");
      const brandKey = `qa-brand-${id()}`;
      createdBrands.push(brandKey);

      await pool.query(
        `INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, is_active)
         VALUES ($1, 'Sweep Windows Brand', 'https://example.test', 'example.test', true)`,
        [brandKey],
      );
      await pool.query(
        `INSERT INTO public.customer_brand_memberships (brand_key, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [brandKey, user],
      );
      await pool.query(
        `INSERT INTO public.user_email_preferences (user_id, scan_results, schedule_alerts, spend_alerts, product_updates)
         VALUES ($1, true, true, true, false)
         ON CONFLICT (user_id) DO UPDATE SET schedule_alerts = true, spend_alerts = true`,
        [user],
      );

      // Ensure scan_schedules exists and has customer schedule
      await pool.query(
        `INSERT INTO public.scan_schedules (brand, display_name, cadence, managed_by, schedule_interval, approved_max_usd, enabled, next_run_at, updated_at)
         VALUES ($1, $1, 'daily', 'customer', 'daily', 1, true, now() + interval '1 day', now())
         ON CONFLICT (brand) DO UPDATE SET managed_by = 'customer', schedule_interval = 'daily', approved_max_usd = 1, enabled = true`,
        [brandKey],
      );

      // Seed a blocked measurement window
      await pool.query(
        `INSERT INTO public.measurement_windows (brand, window_at, disposition, reason, recorded_at)
         VALUES ($1, now(), 'blocked', 'price_changed', now())
         ON CONFLICT (brand, window_at) DO UPDATE SET disposition = 'blocked', reason = 'price_changed'`,
        [brandKey],
      );

      const serviceClient = createServiceClient(pool);
      const now = new Date();
      const res = await sweepWindows(serviceClient, now, { appUrl: "https://app.example.test" });
      assert.ok(res.windows >= 1, "found at least 1 window");

      const utcDay = now.toISOString().slice(0, 10);
      const outboxRes = await pool.query(
        `SELECT * FROM public.email_outbox WHERE dedupe_key = $1`,
        [`schedule_skipped:${brandKey}:price_changed:${utcDay}:${user}`],
      );
      assert.equal(outboxRes.rowCount, 1, "schedule_skipped outbox row must be in DB");
      assert.equal(outboxRes.rows[0].template, "schedule_skipped");
      assert.equal(outboxRes.rows[0].user_id, user);
    });
  } finally {
    for (const brandKey of createdBrands) {
      await pool.query("DELETE FROM public.email_outbox WHERE brand_key = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.workspace_milestones WHERE brand_key = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.measurement_windows WHERE brand = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.scan_schedules WHERE brand = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.content_items WHERE brand = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.gsc_connections WHERE brand = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.scans WHERE brand_key = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.customer_brand_memberships WHERE brand_key = $1", [brandKey]).catch(() => {});
      await pool.query("DELETE FROM public.customer_brands WHERE brand_key = $1", [brandKey]).catch(() => {});
    }
    for (const userId of createdUsers) {
      await pool.query("DELETE FROM public.email_outbox WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM auth.users WHERE id = $1", [userId]).catch(() => {});
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
