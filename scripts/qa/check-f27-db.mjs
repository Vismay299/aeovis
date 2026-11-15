#!/usr/bin/env node
/**
 * F27 database harness — onboarding progress, free-scan handoff, and setup dismissals (170).
 *
 * Groups: website, handoff, dismissals.
 *
 * Requires a disposable loopback PostgreSQL database. Never production:
 * loopback host, _qa/_uat database name, no DATABASE_URL.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f27-db.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
) {
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pool = new pg.Pool({ max: 8 });
const q = (sql, values = []) => pool.query(sql, values);
const id = () => crypto.randomUUID();

const fixtureScan = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests/fixtures/f27/free-scan-row.json"), "utf8"),
);

async function apply170() {
  const sql = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/170_f27_onboarding.sql"),
    "utf8",
  );
  await q(sql);
}

async function test(name, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("ROLLBACK");
    console.log("PASS " + name);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function asUser(client, userId, sql, values = []) {
  await client.query("SAVEPOINT user_sp");
  try {
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await client.query(sql, values);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT user_sp");
  }
}

async function createUser(client, label) {
  const userId = id();
  await client.query(
    "INSERT INTO auth.users(id, email, email_confirmed_at) VALUES($1, $2, now())",
    [userId, `qa-f27-${label}-${userId}@example.test`],
  );
  return userId;
}

try {
  await apply170();

  // Group 1: website
  await test("website", async (client) => {
    const userId = await createUser(client, "website-user");
    const brandKey = `qa-f27-${id()}`;
    const displayName = "Acme QA";
    const website = "https://acme-qa.example";
    const websiteHost = "acme-qa.example";
    const idempotencyKey = `onboarding:${id()}`;

    // Call create_customer_workspace RPC twice with the same idempotency key
    const rpcSql = `
      SELECT public.create_customer_workspace(
        $1, $2, $3, $4, $5, $6, $7
      ) AS result
    `;
    const rpcParams = [
      brandKey,
      displayName,
      website,
      websiteHost,
      userId,
      idempotencyKey,
      JSON.stringify([]),
    ];

    const rpc1 = await client.query(rpcSql, rpcParams);
    assert.ok(rpc1.rows[0].result, "First RPC call creates workspace");

    // Upsert onboarding row
    await client.query(
      `INSERT INTO public.user_onboarding (user_id, brand_key, steps)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET steps = $3`,
      [userId, brandKey, JSON.stringify({ website: { status: "done", at: new Date().toISOString() } })],
    );

    // Second call with same idempotency key
    const rpc2 = await client.query(rpcSql, rpcParams);
    assert.ok(rpc2.rows[0].result, "Second RPC call returns idempotent result");

    await client.query(
      `INSERT INTO public.user_onboarding (user_id, brand_key, steps)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET steps = $3`,
      [userId, brandKey, JSON.stringify({ website: { status: "done", at: new Date().toISOString() } })],
    );

    // Verify: one workspace, one membership, one user_onboarding row
    const brandCount = (
      await client.query("SELECT count(*) FROM public.customer_brands WHERE brand_key = $1", [brandKey])
    ).rows[0].count;
    assert.equal(Number(brandCount), 1, "Exactly one customer_brands row");

    const memberCount = (
      await client.query(
        "SELECT count(*) FROM public.customer_brand_memberships WHERE user_id = $1 AND brand_key = $2",
        [userId, brandKey],
      )
    ).rows[0].count;
    assert.equal(Number(memberCount), 1, "Exactly one customer_brand_memberships row");

    const onboardingCount = (
      await client.query("SELECT count(*) FROM public.user_onboarding WHERE user_id = $1", [userId])
    ).rows[0].count;
    assert.equal(Number(onboardingCount), 1, "Exactly one user_onboarding row");
  });

  // Group 2: handoff
  await test("handoff", async (client) => {
    const userId = await createUser(client, "handoff-user");
    const brandKey = `qa-f27-${id()}`;
    const scanId = id();
    const websiteHost = "acme.example";

    // Create workspace
    await client.query(
      `INSERT INTO public.customer_brands (brand_key, display_name, website, website_host)
       VALUES ($1, 'Acme', 'https://acme.example', $2)`,
      [brandKey, websiteHost],
    );
    await client.query(
      `INSERT INTO public.customer_brand_memberships (user_id, brand_key, role)
       VALUES ($1, $2, 'owner')`,
      [userId, brandKey],
    );

    // Insert fixture scan as anonymous scans row
    await client.query(
      `INSERT INTO public.scans (id, brand, url, brand_key, created_at, scanned_at, raw_results)
       VALUES ($1, $2, $3, NULL, now(), now(), $4)`,
      [scanId, fixtureScan.brand, fixtureScan.url, JSON.stringify(fixtureScan.raw_results)],
    );

    // Filter questions: 8-300 chars, non-control, non-branded, normalized whitespace
    const seen = new Set();
    const questions = [];
    for (const r of fixtureScan.raw_results.results || []) {
      if (r.is_control || r.is_branded_query) continue;
      const qText = String(r.query || "").trim().replace(/\s+/g, " ");
      if (qText.length < 8 || qText.length > 300) continue;
      const lower = qText.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      questions.push(qText);
      if (questions.length >= 30) break;
    }
    assert.equal(questions.length, 24, "24 distinct eligible questions in fixture");

    // Import function logic
    async function doImport() {
      for (const qText of questions) {
        const questionId = id();
        await client.query(
          `INSERT INTO public.workspace_questions (
             id, brand_key, question, status, origin, topic, source_ref, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'paused', 'promptgen', 'From your free scan', $4, now(), now()
           ) ON CONFLICT DO NOTHING`,
          [questionId, brandKey, qText, JSON.stringify({ kind: "free_scan", id: scanId })],
        );
      }
    }

    // Run import
    await doImport();
    const count1 = (
      await client.query(
        "SELECT count(*) FROM public.workspace_questions WHERE brand_key = $1 AND status = 'paused'",
        [brandKey],
      )
    ).rows[0].count;
    assert.equal(Number(count1), 24, "First import inserts 24 paused questions");

    // Run again
    await doImport();
    const count2 = (
      await client.query(
        "SELECT count(*) FROM public.workspace_questions WHERE brand_key = $1 AND status = 'paused'",
        [brandKey],
      )
    ).rows[0].count;
    assert.equal(Number(count2), 24, "Second import leaves exactly 24 questions");
  });

  // Group 3: dismissals
  await test("dismissals", async (client) => {
    const userA = await createUser(client, "user-a");
    const userB = await createUser(client, "user-b");
    const brandKey = `qa-f27-${id()}`;

    // Create workspace with userA as owner, userB as member
    await client.query(
      `INSERT INTO public.customer_brands (brand_key, display_name, website, website_host)
       VALUES ($1, 'Acme Dismiss', 'https://acme-dismiss.example', 'acme-dismiss.example')`,
      [brandKey],
    );
    await client.query(
      `INSERT INTO public.customer_brand_memberships (user_id, brand_key, role)
       VALUES ($1, $3, 'owner'), ($2, $3, 'member')`,
      [userA, userB, brandKey],
    );

    // User A dismisses step "scan"
    await client.query(
      `INSERT INTO public.workspace_setup_dismissals (user_id, brand_key, step, dismissed_at)
       VALUES ($1, $2, 'scan', now())`,
      [userA, brandKey],
    );

    // User A can read own dismissal
    const aRows = (
      await asUser(client, userA, "SELECT step FROM public.workspace_setup_dismissals WHERE brand_key = $1", [
        brandKey,
      ])
    ).rows;
    assert.equal(aRows.length, 1);
    assert.equal(aRows[0].step, "scan");

    // User B cannot read user A's dismissal
    const bRows = (
      await asUser(client, userB, "SELECT step FROM public.workspace_setup_dismissals WHERE brand_key = $1", [
        brandKey,
      ])
    ).rows;
    assert.equal(bRows.length, 0, "User B cannot read User A's dismissal");

    // User A leaves the workspace
    await client.query(
      "DELETE FROM public.customer_brand_memberships WHERE user_id = $1 AND brand_key = $2",
      [userA, brandKey],
    );

    // User A can no longer read the dismissal for the abandoned workspace
    const aRowsAfterLeave = (
      await asUser(client, userA, "SELECT step FROM public.workspace_setup_dismissals WHERE brand_key = $1", [
        brandKey,
      ])
    ).rows;
    assert.equal(aRowsAfterLeave.length, 0, "Leaving workspace hides dismissals via RLS");
  });
} finally {
  await pool.end();
}
