#!/usr/bin/env node
/**
 * F25 database harness:
 *   - outbox     (F25-AC-02: dedupe_key uniqueness, data size check constraint)
 *   - claim      (F25-AC-03: concurrency isolation, next_attempt_at filtering, expired claim recovery, attempt count)
 *   - retention  (F25-AC-15: deletion of old sent/skipped/failed rows, retention of pending and recent rows)
 *
 * Runs against a disposable loopback PostgreSQL database that has migrations applied.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f25-db.mjs
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f25-db.mjs --only outbox,claim,retention
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

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
  } finally {
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
