#!/usr/bin/env node
/**
 * F20 database harness (migration 135 and 136):
 *   - 135: ga4_oauth_attempts, ga4_grants, ga4_connections, RLS
 *   - 136: ga4_upsert_grant, ga4_purge_cache, ga4_set_connection, ga4_disconnect,
 *          ga4_grant_impact, ga4_remove_grant, ga4_list_unused_grants,
 *          ga4_delete_unused_grant, prune_ga4_oauth_attempts
 *
 * Runs against a disposable loopback PostgreSQL database that has every
 * migration applied.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=customer_uat node scripts/qa/check-f20-db.mjs
 *   PGHOST=localhost PGDATABASE=customer_uat node scripts/qa/check-f20-db.mjs --only schema
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
    "F20 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pool = new pg.Pool({ max: 8 });
const query = (sql, values = []) => pool.query(sql, values);
const id = () => crypto.randomUUID();

async function apply135And136() {
  const sql135 = fs.readFileSync(path.join(ROOT, "supabase/migrations/135_f20_ga4.sql"), "utf8");
  const sql136 = fs.readFileSync(path.join(ROOT, "supabase/migrations/136_f20_ga4_functions.sql"), "utf8");
  await query(sql135);
  await query(sql136);
}

if (process.argv.includes("--only") && process.argv[process.argv.indexOf("--only") + 1] === "schema") {
  try {
    await apply135And136();
    await apply135And136();
    console.log("135/136 applied twice without error");
    process.exit(0);
  } catch (err) {
    console.error("Failed to apply 135/136:", err);
    process.exit(1);
  }
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
  const brandKey = `qa-f20-${id()}.example`;
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

async function addMember(brandKey, userId, role = "member") {
  await query(
    "INSERT INTO public.customer_brand_memberships (user_id, brand_key, role) VALUES ($1, $2, $3)",
    [userId, brandKey, role],
  );
}

// ga4_grants_touch resets updated_at on every UPDATE, so backdating needs the
// trigger suppressed for this one statement (loopback QA superuser only).
async function ageGrant(grantId, interval) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query("UPDATE public.ga4_grants SET updated_at = now() - $2::interval WHERE id = $1", [grantId, interval]);
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
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

async function run() {
  await apply135And136();

  // Test 1: Two users linking same Google account -> two grant rows (F20-AC-03)
  const user1 = await createUser("user1");
  const user2 = await createUser("user2");
  const sharedGoogleSub = `sub-${id()}`;

  const res1 = await query(
    "SELECT public.ga4_upsert_grant($1, $2, $3, $4, $5, now() + interval '1 hour', $6) AS id",
    [user1, sharedGoogleSub, "user1@example.com", "enc_rt_1", "enc_at_1", ["openid", "email"]],
  );
  const grantId1 = res1.rows[0].id;

  const res2 = await query(
    "SELECT public.ga4_upsert_grant($1, $2, $3, $4, $5, now() + interval '1 hour', $6) AS id",
    [user2, sharedGoogleSub, "user2@example.com", "enc_rt_2", "enc_at_2", ["openid", "email"]],
  );
  const grantId2 = res2.rows[0].id;

  assert.notEqual(grantId1, grantId2, "two users linking same google sub get distinct grants");

  const grantRows = (
    await query("SELECT id, user_id, google_sub FROM public.ga4_grants WHERE google_sub = $1", [
      sharedGoogleSub,
    ])
  ).rows;
  assert.equal(grantRows.length, 2, "both grant rows exist in ga4_grants");

  // Test 2: Re-upsert without refresh token keeps the existing refresh token (F20-AC-02, F20-AC-03)
  const resReupsert = await query(
    "SELECT public.ga4_upsert_grant($1, $2, $3, $4, $5, now() + interval '1 hour', $6) AS id",
    [user1, sharedGoogleSub, "user1-updated@example.com", null, "enc_at_new", ["openid", "email"]],
  );
  assert.equal(resReupsert.rows[0].id, grantId1);
  const grant1Check = (
    await query("SELECT encrypted_refresh_token, encrypted_access_token FROM public.ga4_grants WHERE id = $1", [
      grantId1,
    ])
  ).rows[0];
  assert.equal(grant1Check.encrypted_refresh_token, "enc_rt_1", "existing refresh token preserved on null");
  assert.equal(grant1Check.encrypted_access_token, "enc_at_new", "new access token updated");

  // Test 3: ga4_set_connection enforces owner role and caller's grant ownership (F20-AC-06)
  const brand1 = await createBrand(user1);
  const user3 = await createUser("user3");
  await addMember(brand1, user3, "member");

  // Member cannot set connection
  await assert.rejects(
    query(
      "SELECT public.ga4_set_connection($1, $2, $3, $4, $5, $6, $7, $8)",
      [brand1, user3, grantId1, "properties/123456", "Prop Display", "UTC", "USD", "Acct Display"],
    ),
    (err) => err.code === "42501" || err.message.includes("owner_required"),
    "member setting connection must be refused with owner_required",
  );

  // Owner cannot use another user's grant
  await assert.rejects(
    query(
      "SELECT public.ga4_set_connection($1, $2, $3, $4, $5, $6, $7, $8)",
      [brand1, user1, grantId2, "properties/123456", "Prop Display", "UTC", "USD", "Acct Display"],
    ),
    (err) => err.code === "P0002" || err.message.includes("ga4_grant_not_found"),
    "owner cannot use another user's grant",
  );

  // Owner with own grant succeeds
  const connRes = await query(
    "SELECT public.ga4_set_connection($1, $2, $3, $4, $5, $6, $7, $8) AS id",
    [brand1, user1, grantId1, "properties/123456", "Prop Display", "UTC", "USD", "Acct Display"],
  );
  assert.ok(connRes.rows[0].id, "connection created");

  // Test 4: ga4_remove_grant cascades connection and reports remainingForGoogleAccount (F20-AC-08)
  const impact = (await query("SELECT public.ga4_grant_impact($1, $2) AS count", [user1, grantId1])).rows[0].count;
  assert.equal(impact, 1, "impact shows 1 connected workspace");

  const remRes = (await query("SELECT public.ga4_remove_grant($1, $2) AS result", [user1, grantId1])).rows[0].result;
  assert.equal(remRes.removed, true);
  assert.equal(remRes.googleSub, sharedGoogleSub);
  assert.deepEqual(remRes.brands, [brand1]);
  assert.equal(remRes.remainingForGoogleAccount, 1, "user2 grant still exists");

  const connAfterRemove = (await query("SELECT * FROM public.ga4_connections WHERE brand_key = $1", [brand1])).rows;
  assert.equal(connAfterRemove.length, 0, "connection was cascaded upon grant removal");

  const remRes2 = (await query("SELECT public.ga4_remove_grant($1, $2) AS result", [user2, grantId2])).rows[0].result;
  assert.equal(remRes2.removed, true);
  assert.equal(remRes2.remainingForGoogleAccount, 0, "no grants remaining for that google account");

  // Test 5: ga4_delete_unused_grant refuses a grant that gained a connection (F20-AC-09)
  const user4 = await createUser("user4");
  const brand2 = await createBrand(user4);
  const grantId4 = (
    await query(
      "SELECT public.ga4_upsert_grant($1, $2, $3, $4, $5, now() + interval '1 hour', $6) AS id",
      [user4, `sub-${id()}`, "user4@example.com", "rt4", "at4", ["openid", "email"]],
    )
  ).rows[0].id;

  // Manually age the grant's updated_at past 24 hours
  await ageGrant(grantId4, "25 hours");

  const unusedBefore = (
    await query("SELECT id FROM public.ga4_list_unused_grants(now() - interval '24 hours', 10)")
  ).rows.map((r) => r.id);
  assert.ok(unusedBefore.includes(grantId4), "aged grant appears in unused list");

  // Now connect brand2 to grantId4
  await query(
    "SELECT public.ga4_set_connection($1, $2, $3, $4, $5, $6, $7, $8)",
    [brand2, user4, grantId4, "properties/999999", "Prop 2", "UTC", "USD", "Acct 2"],
  );

  // Attempt deleteUnusedGrant -> refused because connection exists
  const delRefused = (
    await query("SELECT public.ga4_delete_unused_grant($1, now()) AS result", [grantId4])
  ).rows[0].result;
  assert.equal(delRefused.deleted, false, "grant with connection cannot be deleted as unused");

  // Disconnect brand2 (F20-AC-07)
  const discRes = (await query("SELECT public.ga4_disconnect($1, $2) AS success", [brand2, user4])).rows[0].success;
  assert.equal(discRes, true, "disconnect succeeded");

  // Age updated_at again
  await ageGrant(grantId4, "25 hours");
  const delSuccess = (
    await query("SELECT public.ga4_delete_unused_grant($1, now() - interval '24 hours') AS result", [grantId4])
  ).rows[0].result;
  assert.equal(delSuccess.deleted, true, "unused grant deleted successfully");

  // Test 6: ga4_purge_cache deletes only ga4.% rows of that brand (F20-AC-07)
  const brandCache = await createBrand(user1);
  const brandOther = await createBrand(user1);
  await query(
    // Rows match 042's schema: 64-hex key, workspace scope, exactly one body
    // (storage_path here, value NULL) and size_bytes.
    `INSERT INTO public.provider_cache (key, namespace, version, scope, brand_key, storage_path, size_bytes, expires_at)
     VALUES
     (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'ga4.overview', 1, 'workspace', $1, 'ga4/overview1.json', 2, now() + interval '1 hour'),
     (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'other.test', 1, 'workspace', $1, 'other/body1.json', 2, now() + interval '1 hour'),
     (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'ga4.overview', 1, 'workspace', $2, 'ga4/otherbrand.json', 2, now() + interval '1 hour')`,
    [brandCache, brandOther],
  );

  const purgedPaths = (await query("SELECT public.ga4_purge_cache($1) AS path", [brandCache])).rows.map((r) => r.path);
  assert.deepEqual(purgedPaths, ["ga4/overview1.json"], "purged cache returns ga4 storage path for that brand");

  const remainingCache = (
    await query("SELECT brand_key, namespace FROM public.provider_cache WHERE brand_key IN ($1, $2)", [
      brandCache,
      brandOther,
    ])
  ).rows;
  assert.equal(remainingCache.length, 2);
  assert.ok(remainingCache.some((r) => r.brand_key === brandCache && r.namespace === "other.test"));
  assert.ok(remainingCache.some((r) => r.brand_key === brandOther && r.namespace === "ga4.overview"));

  // Test 7: prune_ga4_oauth_attempts (F20-AC-28)
  const stateHashOld = crypto.createHash("sha256").update("old-attempt").digest("hex");
  const stateHashConsumed = crypto.createHash("sha256").update("consumed-attempt").digest("hex");
  const stateHashFresh = crypto.createHash("sha256").update("fresh-attempt").digest("hex");
  const dummySession = crypto.createHash("sha256").update("session").digest("hex");

  await query(
    `INSERT INTO public.ga4_oauth_attempts (user_id, brand_key, state_hash, session_token_hash, encrypted_code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, 'enc', now() - interval '2 days')`,
    [user1, brandCache, stateHashOld, dummySession],
  );
  await query(
    `INSERT INTO public.ga4_oauth_attempts (user_id, brand_key, state_hash, session_token_hash, encrypted_code_verifier, consumed_at)
     VALUES ($1, $2, $3, $4, 'enc', now() - interval '2 days')`,
    [user1, brandCache, stateHashConsumed, dummySession],
  );
  await query(
    `INSERT INTO public.ga4_oauth_attempts (user_id, brand_key, state_hash, session_token_hash, encrypted_code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, 'enc', now() + interval '10 minutes')`,
    [user1, brandCache, stateHashFresh, dummySession],
  );

  const prunedCount = (await query("SELECT public.prune_ga4_oauth_attempts() AS count")).rows[0].count;
  assert.ok(prunedCount >= 2, "at least 2 attempts pruned");

  const freshRemaining = (
    await query("SELECT id FROM public.ga4_oauth_attempts WHERE state_hash = $1", [stateHashFresh])
  ).rows;
  assert.equal(freshRemaining.length, 1, "fresh attempt remains unpruned");

  // Test 8: RLS (F20-AC-25)
  // ga4_connections is readable only by workspace members; ga4_grants & ga4_oauth_attempts are denied to authenticated.
  const rlsBrandA = await createBrand(user1);
  const rlsBrandB = await createBrand(user2);
  const rlsGrantA = (
    await query(
      "SELECT public.ga4_upsert_grant($1, $2, $3, $4, $5, now() + interval '1 hour', $6) AS id",
      [user1, `sub-rls-${id()}`, "a@example.test", "rt", "at", ["openid", "email"]],
    )
  ).rows[0].id;

  await query(
    "SELECT public.ga4_set_connection($1, $2, $3, $4, $5, $6, $7, $8)",
    [rlsBrandA, user1, rlsGrantA, "properties/111111", "Prop A", "UTC", "USD", "Acct A"],
  );

  // Authenticated user1 reads ga4_connections -> sees brandA, does not see brandB
  await asUser(user1, async (c) => {
    const res = await c.query("SELECT brand_key FROM public.ga4_connections");
    const brandsSeen = res.rows.map((r) => r.brand_key);
    assert.ok(brandsSeen.includes(rlsBrandA), "user1 can see own workspace connection");
    assert.ok(!brandsSeen.includes(rlsBrandB), "user1 cannot see another workspace connection");

    // Denial on service-only tables. Each refusal aborts the transaction, so
    // every probe runs inside its own savepoint.
    const denied = async (sql, params, message) => {
      await c.query("SAVEPOINT probe");
      await assert.rejects(c.query(sql, params), (err) => err.code === "42501", message);
      await c.query("ROLLBACK TO SAVEPOINT probe");
    };
    await denied("SELECT * FROM public.ga4_grants", [], "authenticated role denied SELECT on ga4_grants");
    await denied("SELECT * FROM public.ga4_oauth_attempts", [], "authenticated role denied SELECT on ga4_oauth_attempts");
    await denied(
      "DELETE FROM public.ga4_connections WHERE brand_key = $1",
      [rlsBrandA],
      "authenticated role denied direct DELETE on ga4_connections",
    );
  });

  console.log("F20 DB checks: all passed");
}

try {
  await run();
  await pool.end();
} catch (err) {
  console.error("F20 DB checks failed:", err);
  await pool.end();
  process.exit(1);
}
