#!/usr/bin/env node
/**
 * F06 phase 3 database harness (migration 065): the private `exports` bucket,
 * the absence of any storage-object policy that would expose it, and the
 * `export_requests` path constraint.
 *
 * Runs against a disposable loopback PostgreSQL database only. Never point this
 * at production, and never call the Storage API from here: the bucket row is
 * read from the local `storage.buckets` shim below.
 *
 * Usage:
 *   PGHOST=localhost PGDATABASE=customer_uat node scripts/qa/check-f06-db.mjs
 */
import assert from "node:assert/strict";
import pg from "pg";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
) {
  throw Error(
    "F06 database tests require loopback PGHOST and a disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}

const pool = new pg.Pool({ max: 4 });
const q = (sql, values = []) => pool.query(sql, values);

/**
 * The CI bootstrap creates the minimal Supabase storage schema. A hand-built
 * loopback database may not have it, so create only the two rows this check
 * reads. This is a local shim, not a Storage call.
 */
async function ensureStorageShim() {
  await q("create schema if not exists storage");
  await q(`create table if not exists storage.buckets(
    id text primary key,
    name text,
    public boolean,
    file_size_limit bigint,
    allowed_mime_types text[]
  )`);
  await q(`create table if not exists storage.objects(
    id uuid default gen_random_uuid() primary key,
    bucket_id text
  )`);
}

async function test(name, fn) {
  await fn();
  console.log("PASS " + name);
}

try {
  await ensureStorageShim();

  await test("schema - export_requests exists with RLS enabled", async () => {
    const table = await q("select relrowsecurity from pg_class where oid = 'public.export_requests'::regclass");
    assert.equal(table.rowCount, 1, "migration 065's export_requests table must exist");
    assert.equal(table.rows[0].relrowsecurity, true, "export_requests must have RLS enabled");

    const policy = await q(
      "select 1 from pg_policies where schemaname = 'public' and tablename = 'export_requests' and policyname = 'export_requests_read'",
    );
    assert.equal(policy.rowCount, 1, "the member read policy must exist");
  });

  await test("bucket - exports is private, 25 MiB and CSV/JSON only", async () => {
    const { rows } = await q(
      "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'exports'",
    );
    assert.equal(rows.length, 1, "bucket `exports` must exist");
    assert.equal(rows[0].public, false, "the exports bucket must be private");
    assert.equal(Number(rows[0].file_size_limit), 26_214_400, "25 MiB per object");
    assert.deepEqual(
      [...(rows[0].allowed_mime_types ?? [])].sort(),
      ["application/json", "text/csv"],
      "only CSV and JSON may be stored",
    );
  });

  await test("storage policies - no storage.objects policy mentions exports", async () => {
    const { rows } = await q(
      `select policyname from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%exports%'`,
    );
    assert.deepEqual(rows, [], "the bucket must stay service-role only");
  });

  await test("constraint - export_requests_path_ck rejects a path outside the brand", async () => {
    await q("begin");
    try {
      await q(
        `insert into public.customer_brands(brand_key, display_name, website, website_host)
         values ('acme', 'Acme', 'https://acme.example', 'acme.example')
         on conflict (brand_key) do nothing`,
      );
      await assert.rejects(
        () =>
          q(
            `insert into public.export_requests(brand_key, kind, format, expires_at, storage_path)
             values ('acme', 'workspace_answers', 'csv', now() + interval '1 hour', 'other/x')`,
          ),
        (error) => {
          assert.equal(error.code, "23514", "a check violation, not a generic failure");
          assert.equal(error.constraint, "export_requests_path_ck");
          return true;
        },
      );
    } finally {
      await q("rollback");
    }
  });

  console.log("\nok 1 group on a loopback QA database.");
} finally {
  await pool.end();
}
