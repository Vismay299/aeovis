#!/usr/bin/env node
// Portions ported from every-app/open-seo@c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4 (MIT, © 2026 Ben Senescu):
//   src/server/features/projects/repositories/ProjectRepository.ts:153-168
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F19 database harness: migration 130 (IndexNow keys, submissions, key checks,
 * RLS policies, ensure/usage/recently_submitted functions, and retention pruning).
 *
 * Groups: schema, rls, ensure, usage, history, retention.
 *
 * Requires a disposable loopback PostgreSQL database. Never production:
 * loopback host, _qa/_uat database name, no DATABASE_URL. Connection settings
 * come from the PG* environment variables only.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=customer_uat node scripts/qa/check-f19-db.mjs
 *   PGHOST=localhost PGDATABASE=customer_uat node scripts/qa/check-f19-db.mjs --only schema
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
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  !/(?:_qa|_uat)$/.test(database) ||
  process.env.DATABASE_URL
) {
  throw new Error(
    "F19 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pool = new pg.Pool({ max: 4 });
const query = (sql, values = []) => pool.query(sql, values);
const id = () => crypto.randomUUID();
const passed = [];

const onlyIndex = process.argv.indexOf("--only");
const onlyGroup = onlyIndex !== -1 ? process.argv[onlyIndex + 1] : null;

async function apply130() {
  const sql130 = fs.readFileSync(path.join(ROOT, "supabase/migrations/130_f19_indexnow.sql"), "utf8");
  await query(sql130);
}

async function createUser(emailPrefix) {
  const userId = id();
  await query("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())", [
    userId,
    `${emailPrefix}-${userId}@example.test`,
  ]);
  return userId;
}

async function createBrand(ownerUserId) {
  const brandKey = `qa-f19-${id()}.example`;
  await query(
    "INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, is_active) VALUES ($1, $1, $2, $2, true)",
    [brandKey, `https://${brandKey}`],
  );
  if (ownerUserId) {
    await query(
      "INSERT INTO public.customer_brand_memberships (user_id, brand_key, role) VALUES ($1, $2, 'owner')",
      [ownerUserId, brandKey],
    );
  }
  return brandKey;
}

async function asUser(userId, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

async function runGroup(name, fn) {
  if (onlyGroup && onlyGroup !== name) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("ROLLBACK");
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* retain test failure */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  // Group 1: schema (idempotence)
  if (!onlyGroup || onlyGroup === "schema") {
    try {
      await apply130();
      await apply130();
      passed.push("schema");
      console.log("PASS schema");
    } catch (err) {
      console.error("Failed to apply 130 idempotently:", err);
      throw err;
    }
  }

  // Group 2: rls (row level security and function grants)
  await runGroup("rls", async (client) => {
    const user1 = await createUser("user1");
    const user2 = await createUser("user2");
    const brand1 = await createBrand(user1);
    const brand2 = await createBrand(user2);

    const key1 = crypto.randomBytes(16).toString("hex");
    const key2 = crypto.randomBytes(16).toString("hex");

    await client.query(
      "INSERT INTO public.indexnow_keys (brand_key, key, created_by) VALUES ($1, $2, $3)",
      [brand1, key1, user1],
    );
    await client.query(
      "INSERT INTO public.indexnow_keys (brand_key, key, created_by) VALUES ($1, $2, $3)",
      [brand2, key2, user2],
    );

    const req1 = id();
    const req2 = id();
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_by)
       VALUES ($1, $2, 'settings', $3, 1, ARRAY[$4], 'submitted', 'bing', 200, 'OK', $5)`,
      [brand1, req1, brand1, `https://${brand1}/p1`, user1],
    );
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_by)
       VALUES ($1, $2, 'settings', $3, 1, ARRAY[$4], 'submitted', 'bing', 200, 'OK', $5)`,
      [brand2, req2, brand2, `https://${brand2}/p2`, user2],
    );

    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status) VALUES ($1, $2, 'found')",
      [brand1, brand1],
    );
    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status) VALUES ($1, $2, 'missing')",
      [brand2, brand2],
    );

    // Authenticated user1 reads through RLS
    await asUser(user1, async (c) => {
      // indexnow_keys
      const keys = (await c.query("SELECT brand_key, key FROM public.indexnow_keys")).rows;
      assert.ok(keys.some((r) => r.brand_key === brand1), "user1 can see brand1 key");
      assert.ok(!keys.some((r) => r.brand_key === brand2), "user1 cannot see brand2 key");

      // indexnow_submissions
      const subs = (await c.query("SELECT brand_key, request_id FROM public.indexnow_submissions")).rows;
      assert.ok(subs.some((r) => r.brand_key === brand1), "user1 can see brand1 submissions");
      assert.ok(!subs.some((r) => r.brand_key === brand2), "user1 cannot see brand2 submissions");

      // indexnow_key_checks
      const checks = (await c.query("SELECT brand_key, host FROM public.indexnow_key_checks")).rows;
      assert.ok(checks.some((r) => r.brand_key === brand1), "user1 can see brand1 key checks");
      assert.ok(!checks.some((r) => r.brand_key === brand2), "user1 cannot see brand2 key checks");

      // Direct writes denied for authenticated role
      const denied = async (sql, params, message) => {
        await c.query("SAVEPOINT probe");
        await assert.rejects(c.query(sql, params), (err) => err.code === "42501", message);
        await c.query("ROLLBACK TO SAVEPOINT probe");
      };

      await denied(
        "INSERT INTO public.indexnow_keys (brand_key, key) VALUES ($1, $2)",
        [brand1, crypto.randomBytes(16).toString("hex")],
        "authenticated denied INSERT on indexnow_keys",
      );
      await denied(
        "DELETE FROM public.indexnow_keys WHERE brand_key = $1",
        [brand1],
        "authenticated denied DELETE on indexnow_keys",
      );
      await denied(
        "DELETE FROM public.indexnow_submissions WHERE brand_key = $1",
        [brand1],
        "authenticated denied DELETE on indexnow_submissions",
      );
      await denied(
        "DELETE FROM public.indexnow_key_checks WHERE brand_key = $1",
        [brand1],
        "authenticated denied DELETE on indexnow_key_checks",
      );

      // Functions denied to authenticated
      await denied(
        "SELECT public.indexnow_ensure_key($1, $2, $3)",
        [brand1, crypto.randomBytes(16).toString("hex"), user1],
        "authenticated denied EXECUTE on indexnow_ensure_key",
      );
      await denied(
        "SELECT public.indexnow_usage($1, now())",
        [brand1],
        "authenticated denied EXECUTE on indexnow_usage",
      );
      await denied(
        "SELECT public.indexnow_recently_submitted($1, ARRAY['https://example.com'], now())",
        [brand1],
        "authenticated denied EXECUTE on indexnow_recently_submitted",
      );
      await denied(
        "SELECT public.prune_indexnow(now(), now(), 10)",
        [],
        "authenticated denied EXECUTE on prune_indexnow",
      );
    });
  });

  // Group 3: ensure (converging first use & key format validation)
  await runGroup("ensure", async (client) => {
    const user = await createUser("user-ensure");
    const brand = await createBrand(user);

    // Invalid key format raises indexnow_key_invalid
    await assert.rejects(
      client.query("SELECT * FROM public.indexnow_ensure_key($1, $2, $3)", [brand, "invalid-key-shape", user]),
      (err) => err.message.includes("indexnow_key_invalid"),
      "invalid key length/chars raises indexnow_key_invalid",
    );

    const keyA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const keyB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // First ensure: inserts keyA and returns created: true
    const resA = (await client.query("SELECT * FROM public.indexnow_ensure_key($1, $2, $3)", [brand, keyA, user])).rows[0];
    assert.equal(resA.key, keyA);
    assert.equal(resA.created, true);

    // Concurrent/second ensure with different keyB: converges on keyA and returns created: false
    const resB = (await client.query("SELECT * FROM public.indexnow_ensure_key($1, $2, $3)", [brand, keyB, user])).rows[0];
    assert.equal(resB.key, keyA);
    assert.equal(resB.created, false);

    // Stored key is unchanged
    const stored = (await client.query("SELECT key FROM public.indexnow_keys WHERE brand_key = $1", [brand])).rows[0];
    assert.equal(stored.key, keyA);
  });

  // Group 4: usage (counts across hour and day boundaries)
  await runGroup("usage", async (client) => {
    const user = await createUser("user-usage");
    const brand = await createBrand(user);
    const now = new Date("2026-11-08T14:30:00.000Z");

    // Initially zero
    const emptyUsage = (await client.query("SELECT public.indexnow_usage($1, $2) AS u", [brand, now.toISOString()])).rows[0].u;
    assert.equal(emptyUsage.requestsLastHour, 0);
    assert.equal(emptyUsage.oldestRequestInHour, null);
    assert.equal(emptyUsage.urlsToday, 0);
    assert.equal(emptyUsage.checksLastHour, 0);
    assert.equal(emptyUsage.oldestCheckInHour, null);

    const req1 = id();
    const req2 = id();
    const req3 = id();
    const reqOld = id();

    // req1: 2 rows with same request_id (two hosts in one batch), 20 min ago
    const t20m = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'settings', 'host1.com', 5, ARRAY['https://host1.com/1'], 'submitted', 'bing', 200, 'OK', $3)`,
      [brand, req1, t20m],
    );
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'settings', 'host2.com', 10, ARRAY['https://host2.com/2'], 'submitted', 'bing', 200, 'OK', $3)`,
      [brand, req1, t20m],
    );

    // req2: 45 min ago
    const t45m = new Date(now.getTime() - 45 * 60 * 1000).toISOString();
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'audit', 'host1.com', 8, ARRAY['https://host1.com/3'], 'submitted', 'bing', 200, 'OK', $3)`,
      [brand, req2, t45m],
    );

    // req3: 90 min ago (earlier today UTC: 13:00 UTC)
    const t90m = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'content', 'host1.com', 12, ARRAY['https://host1.com/4'], 'submitted', 'bing', 200, 'OK', $3)`,
      [brand, req3, t90m],
    );

    // reqOld: yesterday UTC (2026-11-07T23:50:00Z)
    const tYesterday = new Date("2026-11-07T23:50:00.000Z").toISOString();
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'settings', 'host1.com', 100, ARRAY['https://host1.com/old'], 'submitted', 'bing', 200, 'OK', $3)`,
      [brand, reqOld, tYesterday],
    );

    // Key checks: 2 within hour, 1 earlier
    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status, checked_at) VALUES ($1, 'host1.com', 'found', $2)",
      [brand, t20m],
    );
    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status, checked_at) VALUES ($1, 'host2.com', 'found', $2)",
      [brand, t45m],
    );
    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status, checked_at) VALUES ($1, 'host1.com', 'found', $2)",
      [brand, t90m],
    );

    const usage = (await client.query("SELECT public.indexnow_usage($1, $2) AS u", [brand, now.toISOString()])).rows[0].u;
    assert.equal(usage.requestsLastHour, 2, "req1 and req2 distinct requests within 1 hour");
    assert.ok(usage.oldestRequestInHour, "has oldestRequestInHour");
    assert.equal(new Date(usage.oldestRequestInHour).toISOString(), new Date(t45m).toISOString());
    assert.equal(usage.urlsToday, 5 + 10 + 8 + 12, "urlsToday sums all today UTC url_counts, excludes yesterday");
    assert.equal(usage.checksLastHour, 2, "checksLastHour counts checks in last 60 minutes");
    assert.ok(usage.oldestCheckInHour, "has oldestCheckInHour");
    assert.equal(new Date(usage.oldestCheckInHour).toISOString(), new Date(t45m).toISOString());
  });

  // Group 5: history (recently submitted URLs)
  await runGroup("history", async (client) => {
    const user = await createUser("user-history");
    const brand = await createBrand(user);
    const otherBrand = await createBrand(user);

    const now = new Date();
    const t5m = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const t25m = new Date(now.getTime() - 25 * 60 * 1000).toISOString();
    const since10m = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

    const uA = `https://${brand}/a`;
    const uB = `https://${brand}/b`;
    const uFailed = `https://${brand}/c`;
    const uOld = `https://${brand}/d`;
    const uOther = `https://${otherBrand}/e`;

    // Successful submission 5m ago with uA, uB
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'settings', $3, 2, ARRAY[$4, $5], 'submitted', 'bing', 200, 'OK', $6)`,
      [brand, id(), brand, uA, uB, t5m],
    );

    // Failed submission 5m ago with uFailed
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'settings', $3, 1, ARRAY[$4], 'failed', 'bing', 500, 'Error', $5)`,
      [brand, id(), brand, uFailed, t5m],
    );

    // Successful submission 25m ago with uOld
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'settings', $3, 1, ARRAY[$4], 'submitted', 'bing', 200, 'OK', $5)`,
      [brand, id(), brand, uOld, t25m],
    );

    // Other brand submission 5m ago
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, engine, http_status, message, created_at)
       VALUES ($1, $2, 'settings', $3, 1, ARRAY[$4], 'submitted', 'bing', 200, 'OK', $5)`,
      [otherBrand, id(), otherBrand, uOther, t5m],
    );

    // Query for brand: uA, uB, uFailed, uOld, uOther, plus an unsubmitted URL
    const queryUrls = [uA, uFailed, uOld, uOther, `https://${brand}/never`];
    const res = (
      await client.query("SELECT public.indexnow_recently_submitted($1, $2, $3) AS urls", [
        brand,
        queryUrls,
        since10m,
      ])
    ).rows[0].urls;

    assert.deepEqual(res, [uA], "only submitted URLs for this brand within since window returned");

    // When no URLs match
    const emptyRes = (
      await client.query("SELECT public.indexnow_recently_submitted($1, $2, $3) AS urls", [
        brand,
        [`https://${brand}/unmatched`],
        since10m,
      ])
    ).rows[0].urls;
    assert.deepEqual(emptyRes, [], "returns empty array on no matches");
  });

  // Group 6: retention (prune_indexnow)
  await runGroup("retention", async (client) => {
    const user = await createUser("user-retention");
    const brand = await createBrand(user);

    const now = new Date();
    const tOld = new Date(now.getTime() - 400 * 24 * 3600 * 1000).toISOString();
    const tRecent = new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString();
    const cutoffSubmissions = new Date(now.getTime() - 395 * 24 * 3600 * 1000).toISOString();
    const cutoffChecks = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

    // 2 old submissions, 1 recent submission
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, message, created_at)
       VALUES ($1, $2, 'settings', $3, 1, ARRAY['https://example.com/1'], 'submitted', 'OK', $4)`,
      [brand, id(), brand, tOld],
    );
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (brand_key, request_id, source, host, url_count, urls, status, message, created_at)
       VALUES ($1, $2, 'settings', $3, 1, ARRAY['https://example.com/2'], 'submitted', 'OK', $4)`,
      [brand, id(), brand, tOld],
    );
    const recentSubId = id();
    await client.query(
      `INSERT INTO public.indexnow_submissions
        (id, brand_key, request_id, source, host, url_count, urls, status, message, created_at)
       VALUES ($1, $2, $3, 'settings', $4, 1, ARRAY['https://example.com/3'], 'submitted', 'OK', $5)`,
      [recentSubId, brand, id(), brand, tRecent],
    );

    // 3 old checks, 1 recent check
    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status, checked_at) VALUES ($1, $2, 'found', $3)",
      [brand, brand, tOld],
    );
    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status, checked_at) VALUES ($1, $2, 'found', $3)",
      [brand, brand, tOld],
    );
    await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status, checked_at) VALUES ($1, $2, 'found', $3)",
      [brand, brand, tOld],
    );
    const recentCheckRes = await client.query(
      "INSERT INTO public.indexnow_key_checks (brand_key, host, status, checked_at) VALUES ($1, $2, 'found', $3) RETURNING id",
      [brand, brand, now.toISOString()],
    );
    const recentCheckId = recentCheckRes.rows[0].id;

    // Prune with limit 10
    const pruneRes = (
      await client.query("SELECT public.prune_indexnow($1, $2, 10) AS p", [cutoffSubmissions, cutoffChecks])
    ).rows[0].p;

    assert.equal(pruneRes.submissions, 2, "pruned 2 old submissions");
    assert.equal(pruneRes.checks, 3, "pruned 3 old checks");

    // Verify recent rows remain
    const remainingSubs = (
      await client.query("SELECT id FROM public.indexnow_submissions WHERE id = $1", [recentSubId])
    ).rows;
    assert.equal(remainingSubs.length, 1, "recent submission preserved");

    const remainingChecks = (
      await client.query("SELECT id FROM public.indexnow_key_checks WHERE id = $1", [recentCheckId])
    ).rows;
    assert.equal(remainingChecks.length, 1, "recent check preserved");
  });

  console.log(`ok ${passed.length} groups`);
}

main()
  .catch((err) => {
    console.error("FAIL F19 database harness:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
