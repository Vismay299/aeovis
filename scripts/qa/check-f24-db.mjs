#!/usr/bin/env node
/**
 * F24 database harness: migration 155 (disposable-email guard and the Supabase
 * "Before User Created" hook).
 *
 * Groups: idempotent, grants, hook, parity.
 *
 * Requires a disposable loopback PostgreSQL database. Never production:
 * loopback host, _qa/_uat database name, no DATABASE_URL. Connection settings
 * come from the PG* environment variables only.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f24-db.mjs
 *   PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f24-db.mjs --fresh
 *
 * Without --fresh the database is assumed to hold the earlier migrations
 * already (the CI `customer-database` job applies every file first); only 155
 * is applied here, twice. With --fresh the auth, storage and public schemas
 * are recreated, tests/supabase-bootstrap.sql runs (roles that already exist
 * are tolerated, as roles are cluster-wide), and every file in
 * supabase/migrations is applied in lexical order, as CI does.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
)
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const MIGRATION_155 = "155_f24_signup_guard.sql";
const FRESH = process.argv.includes("--fresh");
const pool = new pg.Pool({ max: 4 });
const q = (sql, values = []) => pool.query(sql, values);
const id = () => crypto.randomUUID();
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

async function test(name, fn) {
  await fn();
  console.log("PASS " + name);
}

/** Run `fn(client)` as `role` inside a transaction that is always rolled back. */
async function asRole(role, fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    return await fn(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

/** Expect `sql` to fail with SQLSTATE 42501 (insufficient_privilege) for `role`. */
async function assertDenied(role, sql) {
  await assert.rejects(
    asRole(role, (c) => c.query(sql)),
    (e) => e.code === "42501",
    `${role} must get permission denied for: ${sql}`,
  );
}

async function freshDatabase() {
  const bootstrap = read("tests/supabase-bootstrap.sql");
  // Roles are cluster-wide and may exist already: create them one by one and
  // tolerate duplicate_object. Everything else is plain DDL on fresh schemas.
  const roleStatements = [...bootstrap.matchAll(/^CREATE ROLE [^;]+;$/gm)].map((m) => m[0]);
  const rest = bootstrap.replace(/^CREATE ROLE [^;]+;$/gm, "");
  for (const statement of roleStatements) {
    try {
      await q(statement);
    } catch (e) {
      if (e.code !== "42710") throw e;
    }
  }
  await q("drop schema if exists auth cascade");
  await q("drop schema if exists storage cascade");
  await q("drop schema if exists public cascade");
  await q("create schema public");
  await q(rest);
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.ok(files.includes(MIGRATION_155), "migration 155 must be on disk");
  for (const file of files) {
    try {
      await q(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
    } catch (e) {
      throw new Error(`migration ${file} failed: ${e.message}`);
    }
  }
  console.log(`fresh: applied ${files.length} migrations in lexical order`);
}

const apply155 = () => q(fs.readFileSync(path.join(MIGRATIONS, MIGRATION_155), "utf8"));
const callHook = (event, client) =>
  (client ?? pool).query("select public.hook_before_user_created($1::jsonb) as result", [
    JSON.stringify(event),
  ]);

async function main() {
  if (FRESH) await freshDatabase();

  await test("idempotent", async () => {
    await apply155();
    await apply155();
    const count = await q("select count(*)::int n from public.disposable_email_domains");
    assert.equal(count.rows[0].n, 37, "seed must hold exactly 37 rows after two applies");
    const rls = await q(
      "select relrowsecurity from pg_class where oid = 'public.disposable_email_domains'::regclass",
    );
    assert.equal(rls.rows[0].relrowsecurity, true, "RLS must be enabled");
    const policies = await q(
      "select count(*)::int n from pg_policies where schemaname = 'public' and tablename = 'disposable_email_domains'",
    );
    assert.equal(policies.rows[0].n, 0, "no policy may exist for anon or authenticated");
  });

  await test("grants", async () => {
    for (const role of ["anon", "authenticated"]) {
      await assertDenied(role, "select public.hook_before_user_created('{}'::jsonb)");
      await assertDenied(role, "select public.is_disposable_email_domain('mailinator.com')");
      await assertDenied(role, "select * from public.disposable_email_domains");
    }
    const service = await asRole("service_role", (c) => callHook({}, c));
    assert.deepEqual(service.rows[0].result, {}, "service_role may call the hook");
    const auth = await q("select 1 from pg_roles where rolname = 'supabase_auth_admin'");
    if (auth.rowCount === 0) {
      console.log(
        "NOTE grants: role supabase_auth_admin does not exist in this database; " +
          "skipping its execute assertion (CI and --fresh create it from tests/supabase-bootstrap.sql)",
      );
    } else {
      const result = await asRole("supabase_auth_admin", (c) => callHook({}, c));
      assert.deepEqual(result.rows[0].result, {}, "supabase_auth_admin may call the hook");
      const disposable = await asRole("supabase_auth_admin", (c) =>
        callHook({ user: { email: "qa@mailinator.com" } }, c),
      );
      assert.equal(disposable.rows[0].result.error.http_code, 400);
    }
  });

  await test("hook", async () => {
    const cases = JSON.parse(read("tests/fixtures/f24/hook-events.json"));
    assert.equal(cases.length, 8, "the fixture holds eight events");
    const brand = `qa-f24-${id()}.example`;
    const user = id();
    let seeded = false;
    try {
      for (const c of cases) {
        if (c.invite) {
          seeded = true;
          await q("insert into auth.users(id, email) values ($1, $2)", [user, "qa-owner@example.test"]);
          await q(
            "insert into public.customer_brands(brand_key, display_name, website, website_host) values ($1, 'F24 QA', $2, $1)",
            [brand, `https://${brand}`],
          );
          await q(
            "insert into public.customer_team_invites(brand_key, email, invited_by) values ($1, $2, $3)",
            [brand, c.invite, user],
          );
        }
        const result = await callHook(c.event);
        assert.deepEqual(result.rows[0].result, c.expected, c.name);
        if (c.invite) {
          // An expired or revoked invitation does not admit the address.
          await q("update public.customer_team_invites set expires_at = now() - interval '1 minute' where brand_key = $1", [brand]);
          const expired = await callHook(c.event);
          assert.equal(expired.rows[0].result.error?.http_code, 400, `${c.name}: expired invite must not admit`);
          await q("update public.customer_team_invites set expires_at = now() + interval '1 day', status = 'revoked' where brand_key = $1", [brand]);
          const revoked = await callHook(c.event);
          assert.equal(revoked.rows[0].result.error?.http_code, 400, `${c.name}: revoked invite must not admit`);
        }
      }
    } finally {
      if (seeded) {
        await q("delete from public.customer_team_invites where brand_key = $1", [brand]);
        await q("delete from public.customer_brands where brand_key = $1", [brand]);
        await q("delete from auth.users where id = $1", [user]);
      }
    }
  });

  await test("parity", async () => {
    const { DISPOSABLE_EMAIL_DOMAINS } = await import(
      pathToFileURL(path.join(ROOT, "src/shared/disposable-email.ts")).href
    );
    const expected = [...DISPOSABLE_EMAIL_DOMAINS].sort();
    const fromSql = [...read("supabase/migrations", MIGRATION_155).matchAll(/\('([a-z0-9.-]+)','openseo'\)/g)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(fromSql, expected, "the SQL seed list must equal DISPOSABLE_EMAIL_DOMAINS");
    const rows = await q(
      "select domain from public.disposable_email_domains where source = 'openseo'",
    );
    // Sorted here, not with ORDER BY: the database's collation (en_US on CI)
    // ignores hyphens, so "mail-temp.com" would sort apart from JS's order.
    assert.deepEqual(
      rows.rows.map((r) => r.domain).sort(),
      expected,
      "the seeded table rows must equal DISPOSABLE_EMAIL_DOMAINS",
    );
  });
}

try {
  await main();
} finally {
  await pool.end();
}
