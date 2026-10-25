#!/usr/bin/env node
/**
 * F26 database harness — telemetry_id + user_privacy_choices (165).
 *
 * Requires a disposable loopback PostgreSQL database with migrations applied
 * through 165. Never production: loopback host, _qa/_uat name, no DATABASE_URL.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f26-db.mjs
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
)
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");

const pool = new pg.Pool({ max: 8 });
const q = (sql, values = []) => pool.query(sql, values);
const id = () => crypto.randomUUID();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function apply165() {
  const sql = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/165_f26_privacy_and_telemetry_ids.sql"),
    "utf8",
  );
  await q(sql);
}

async function test(name, fn) {
  await fn();
  console.log("PASS " + name);
}

async function asUser(user, sql, values = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    return await c.query(sql, values);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

const users = [];
const brands = [];

async function createUser(label) {
  const userId = id();
  await q("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [
    userId,
    `qa-f26-${label}-${userId}@example.test`,
  ]);
  users.push(userId);
  return userId;
}

async function createBrand(member) {
  const brand = `qa-f26-${id()}.example`;
  await q(
    "insert into customer_brands(brand_key,display_name,website,website_host) values($1,$1,$2,$2)",
    [brand, `https://${brand}`],
  );
  if (member) {
    await q("insert into customer_brand_memberships(user_id,brand_key,role) values($1,$2,'owner')", [
      member,
      brand,
    ]);
  }
  brands.push(brand);
  return brand;
}

try {
  await apply165();

  await test("telemetry-id", async () => {
    // Pre-existing rows (if any without a unique id) — after migration every row has a non-null unique id.
    const before = (await q("select brand_key, telemetry_id from customer_brands")).rows;
    const ids = before.map((r) => r.telemetry_id).filter(Boolean);
    assert.equal(ids.length, before.length, "every workspace has a telemetry_id");
    assert.equal(new Set(ids).size, ids.length, "telemetry_id values are unique");

    const owner = await createUser("owner");
    const brand = await createBrand(owner);
    const row = (await q("select telemetry_id from customer_brands where brand_key=$1", [brand])).rows[0];
    assert.ok(row.telemetry_id, "create_customer_workspace-style insert gets a telemetry_id");
    const firstId = row.telemetry_id;

    // Re-applying 165 changes no id.
    await apply165();
    const again = (await q("select telemetry_id from customer_brands where brand_key=$1", [brand])).rows[0];
    assert.equal(again.telemetry_id, firstId, "re-applying 165 must not rotate telemetry_id");
  });

  await test("rls", async () => {
    const a = await createUser("a");
    const b = await createUser("b");
    await q(
      `insert into user_privacy_choices(user_id, analytics, source, policy_version)
       values ($1, true, 'settings', '2026-10-22'), ($2, false, 'banner', '2026-10-22')`,
      [a, b],
    );

    const aRows = (await asUser(a, "select user_id, analytics from user_privacy_choices")).rows;
    assert.equal(aRows.length, 1);
    assert.equal(aRows[0].user_id, a);
    assert.equal(aRows[0].analytics, true);

    const bRows = (await asUser(b, "select user_id, analytics from user_privacy_choices")).rows;
    assert.equal(bRows.length, 1);
    assert.equal(bRows[0].user_id, b);

    await assert.rejects(
      () =>
        asUser(a, "insert into user_privacy_choices(user_id, analytics, source, policy_version) values($1,true,'settings','2026-10-22')", [
          a,
        ]),
      /permission denied|violates/,
      "authenticated cannot write privacy choices",
    );
  });
} finally {
  for (const brand of brands) {
    await q("delete from customer_brand_memberships where brand_key=$1", [brand]).catch(() => {});
    await q("delete from customer_brands where brand_key=$1", [brand]).catch(() => {});
  }
  for (const userId of users) {
    await q("delete from user_privacy_choices where user_id=$1", [userId]).catch(() => {});
    await q("delete from auth.users where id=$1", [userId]).catch(() => {});
  }
  await pool.end();
}
