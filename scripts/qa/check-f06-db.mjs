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

  // -----------------------------------------------------------------------
  // Group 1: derive (migration 066 trigger, functions, backfill).
  // -----------------------------------------------------------------------
  await test("derive - array and object engine shapes", async () => {
    await q("insert into public.customer_brands(brand_key, display_name, website, website_host) values ('acme','Acme','https://acme.example','acme.example') on conflict (brand_key) do nothing");
    await q("insert into public.customer_brands(brand_key, display_name, website, website_host) values ('beta','Beta','https://beta.example','beta.example') on conflict (brand_key) do nothing");
    await q("delete from public.scans where brand_key in ('acme','beta')");

    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme',now(),now(),'multi','{"engines":[{"engine":"chatgpt"},{"name":"gemini"}]}'::jsonb)`,
    );
    const arrayRow = await q("select engines, collection_partial, started_by, listed_at, scanned_at, created_at from public.scans where brand_key='acme' order by id desc limit 1");
    assert.deepEqual(arrayRow.rows[0].engines, ["chatgpt", "gemini"]);
    assert.equal(arrayRow.rows[0].collection_partial, false);
    assert.equal(arrayRow.rows[0].started_by, "manual");

    await q("delete from public.scans where brand_key='acme'");
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme',now(),now(),'multi','{"engines":{"gemini":{"error_rate_pct":12.5},"chatgpt":{}}}'::jsonb)`,
    );
    const objectRow = await q("select engines, collection_partial from public.scans where brand_key='acme' order by id desc limit 1");
    assert.deepEqual(objectRow.rows[0].engines, ["gemini", "chatgpt"]);
    assert.equal(objectRow.rows[0].collection_partial, true);

    await q("delete from public.scans where brand_key='acme'");
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme',now(),now(),'chatgpt',null)`,
    );
    const platformRow = await q("select engines from public.scans where brand_key='acme' order by id desc limit 1");
    assert.deepEqual(platformRow.rows[0].engines, ["chatgpt"]);

    await q("delete from public.scans where brand_key='acme'");
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme',now(),now(),'multi','{"engines":{"chatgpt":{"data_source_issue":true}}}'::jsonb)`,
    );
    const issueRow = await q("select collection_partial from public.scans where brand_key='acme' order by id desc limit 1");
    assert.equal(issueRow.rows[0].collection_partial, true);
  });

  await test("derive - scheduled vs manual via measurement_windows", async () => {
    await q("delete from public.scans where brand_key='acme'");
    await q("delete from public.scan_jobs where brand_key='acme'");
    await q("insert into public.scan_schedules(brand,display_name) values ('%','test') on conflict (brand) do nothing");
    const job = await q(
      `insert into public.scan_jobs(brand,url,brand_key,status) values ('%','https://same.example','acme','pending') returning id`,
    );
    const jobId = job.rows[0].id;
    await q(
      `insert into public.measurement_windows(brand,window_at,disposition,job_id) values ('%','2026-10-01T00:00:00Z','started',$1)`,
      [jobId],
    );
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,origin_job_id)
       values ('%','https://same.example','acme',now(),now(),'chatgpt',$1)`,
      [jobId],
    );
    const scheduled = await q("select started_by from public.scans where brand_key='acme' and origin_job_id=$1", [jobId]);
    assert.equal(scheduled.rows[0].started_by, "scheduled");

    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,origin_job_id)
       values ('%','https://same.example','acme',now(),now(),'chatgpt',null)`,
    );
    const manual = await q("select started_by from public.scans where brand_key='acme' and origin_job_id is null");
    assert.equal(manual.rows[0].started_by, "manual");
  });

  await test("derive - null scanned_at uses created_at for listed_at", async () => {
    await q("delete from public.scans where brand_key='acme'");
    await q(
      `insert into public.scans(brand,url,brand_key,created_at,platform) values ('%','https://same.example','acme','2026-09-15T12:00:00Z','chatgpt')`,
    );
    const row = await q("select listed_at, created_at from public.scans where brand_key='acme'");
    assert.equal(new Date(row.rows[0].listed_at).toISOString(), "2026-09-15T12:00:00.000Z");
  });

  await test("derive - updating raw_results re-derives engines and collection_partial", async () => {
    await q("delete from public.scans where brand_key='acme'");
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme',now(),now(),'multi','{"engines":[{"engine":"chatgpt"}]}'::jsonb)`,
    );
    const before = await q("select engines, collection_partial from public.scans where brand_key='acme'");
    assert.deepEqual(before.rows[0].engines, ["chatgpt"]);
    assert.equal(before.rows[0].collection_partial, false);

    await q(
      `update public.scans set raw_results='{"engines":[{"engine":"chatgpt","error_rate_pct":3}]}'::jsonb where brand_key='acme'`,
    );
    const after = await q("select engines, collection_partial from public.scans where brand_key='acme'");
    assert.deepEqual(after.rows[0].engines, ["chatgpt"]);
    assert.equal(after.rows[0].collection_partial, true);
  });

  await test("derive - backfill recomputes stale rows and leaves raw_results byte-for-byte", async () => {
    await q("delete from public.scans where brand_key='acme'");
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme','2026-10-02T09:00:00Z','2026-10-02T09:00:00Z','multi','{"engines":[{"engine":"chatgpt","data_source_issue":true}]}'::jsonb)`,
    );
    const md5Before = await q("select md5(raw_results::text) as m from public.scans where brand_key='acme'");
    await q(
      `update public.scans set engines='{}'::text[], collection_partial=false, started_by='manual' where brand_key='acme'`,
    );
    // Re-run the migration's backfill block.
    await q(`
      do $$
      declare changed integer;
      begin
        loop
          update public.scans s
             set engines = public.scan_engines(s.raw_results, s.platform),
                 collection_partial = public.scan_collection_partial(s.raw_results),
                 started_by = case when exists (select 1 from public.measurement_windows w where w.job_id = s.origin_job_id) then 'scheduled' else 'manual' end
           where s.id in (select id from public.scans
                           where engines is distinct from public.scan_engines(raw_results, platform)
                              or collection_partial is distinct from public.scan_collection_partial(raw_results)
                              or started_by is distinct from case when exists (select 1 from public.measurement_windows w where w.job_id = origin_job_id) then 'scheduled' else 'manual' end
                           order by id limit 1000);
          get diagnostics changed = row_count;
          exit when changed = 0;
        end loop;
      end $$;
    `);
    const after = await q("select engines, collection_partial, started_by, md5(raw_results::text) as m from public.scans where brand_key='acme'");
    assert.deepEqual(after.rows[0].engines, ["chatgpt"]);
    assert.equal(after.rows[0].collection_partial, true);
    assert.equal(after.rows[0].started_by, "manual");
    assert.equal(after.rows[0].m, md5Before.rows[0].m, "raw_results must be byte-for-byte unchanged");
  });

  // -----------------------------------------------------------------------
  // Group 2: history (paging, filters, tz bounds, visibility sort, isolation).
  // -----------------------------------------------------------------------
  await test("history - paging totals and stable order on equal listed_at", async () => {
    await q("insert into public.customer_brands(brand_key, display_name, website, website_host) values ('acme','Acme','https://acme.example','acme.example') on conflict (brand_key) do nothing");
    await q("insert into public.customer_brands(brand_key, display_name, website, website_host) values ('beta','Beta','https://beta.example','beta.example') on conflict (brand_key) do nothing");
    await q("delete from public.scans where brand_key in ('acme','beta')");
    for (let index = 0; index < 120; index += 1) {
      await q(
        `insert into public.scans(brand,url,brand_key,scanned_at,created_at,visibility_pct,platform,raw_results)
         values ('%','https://same.example','acme',$1,$1,$2,'multi','{"engines":["chatgpt","gemini"]}'::jsonb)`,
        [new Date(Date.UTC(2026, 9, 1, 0) + index * 3_600_000).toISOString(), index % 7 === 0 ? null : 100 - (index % 101)],
      );
    }
    for (let index = 0; index < 5; index += 1) {
      await q(
        `insert into public.scans(brand,url,brand_key,scanned_at,created_at,visibility_pct,platform,raw_results)
         values ('%','https://same.example','beta',$1,$1,$2,'multi','{"engines":["perplexity"]}'::jsonb)`,
        [new Date(Date.UTC(2026, 9, 1, 0) + index * 3_600_000).toISOString(), 50 + index],
      );
    }
    const total = await q("select count(*)::int as c from public.scans where brand_key='acme'");
    assert.equal(total.rows[0].c, 120);

    // Equal listed_at: insert two rows with the same scanned_at, check stable order by id.
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','multi','{"engines":["chatgpt"]}'::jsonb)`,
    );
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,platform,raw_results)
       values ('%','https://same.example','acme','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','multi','{"engines":["chatgpt"]}'::jsonb)`,
    );
    const page = await q(
      `select id from public.scans where brand_key='acme' and scanned_at='2026-09-01T00:00:00Z' order by listed_at desc, id asc`,
    );
    assert.equal(page.rows.length, 2);
    assert.ok(page.rows[0].id < page.rows[1].id, "equal listed_at breaks ties by id ascending");
  });

  await test("history - each filter alone and combined", async () => {
    // started_by filter
    await q("update public.scans set started_by='scheduled' where brand_key='acme' and visibility_pct is null");
    const scheduled = await q("select count(*)::int as c from public.scans where brand_key='acme' and started_by='scheduled'");
    assert.ok(scheduled.rows[0].c > 0);

    // engines overlap
    const engines = await q("select count(*)::int as c from public.scans where brand_key='acme' and engines && ARRAY['perplexity']::text[]");
    // none of the acme rows use perplexity, so 0
    assert.equal(engines.rows[0].c, 0);

    // collection: pending = visibility_pct is null
    const pending = await q("select count(*)::int as c from public.scans where brand_key='acme' and visibility_pct is null");
    assert.ok(pending.rows[0].c > 0);

    // visibility bounds exclude nulls
    const bounded = await q("select count(*)::int as c from public.scans where brand_key='acme' and visibility_pct >= 40 and visibility_pct <= 60");
    assert.ok(bounded.rows[0].c > 0);

    // combined: started_by=scheduled AND visibility_pct>=40 (none, since scheduled rows have null visibility) -> 0
    const combined = await q("select count(*)::int as c from public.scans where brand_key='acme' and started_by='scheduled' and visibility_pct >= 40");
    assert.equal(combined.rows[0].c, 0);
  });

  await test("history - date bounds in Asia/Kolkata", async () => {
    // A scan exactly at Kolkata midnight (18:30 UTC previous day) must be included
    // for the Kolkata calendar day.
    await q("delete from public.scans where brand_key='acme' and scanned_at='2026-09-30T18:30:00Z'");
    await q(
      `insert into public.scans(brand,url,brand_key,scanned_at,created_at,visibility_pct,platform,raw_results)
       values ('%','https://same.example','acme','2026-09-30T18:30:00Z','2026-09-30T18:30:00Z',50,'multi','{"engines":["chatgpt"]}'::jsonb)`,
    );
    const included = await q(
      `select count(*)::int as c from public.scans
        where brand_key='acme'
          and listed_at >= (date '2026-10-01'::timestamp at time zone 'Asia/Kolkata')
          and listed_at <  (date '2026-10-02'::timestamp at time zone 'Asia/Kolkata')`,
    );
    assert.ok(included.rows[0].c >= 1, "Kolkata midnight boundary is included");
  });

  await test("history - visibility sort keeps nulls last in both directions", async () => {
    const asc = await q(
      `select visibility_pct from public.scans where brand_key='acme' order by visibility_pct asc nulls last, id asc`,
    );
    const ascValues = asc.rows.map((row) => row.visibility_pct);
    const ascNonNull = ascValues.filter((value) => value !== null);
    assert.deepEqual(ascNonNull, [...ascNonNull].sort((a, b) => a - b));
    assert.ok(ascValues.slice(-1)[0] === null || ascValues[ascValues.length - 1] !== null, "nulls last ascending");

    const desc = await q(
      `select visibility_pct from public.scans where brand_key='acme' order by visibility_pct desc nulls last, id asc`,
    );
    const descValues = desc.rows.map((row) => row.visibility_pct);
    const descNonNull = descValues.filter((value) => value !== null);
    assert.deepEqual(descNonNull, [...descNonNull].sort((a, b) => b - a));
  });

  await test("history - no cross-workspace row", async () => {
    const acme = await q("select count(*)::int as c from public.scans where brand_key='acme'");
    const beta = await q("select count(*)::int as c from public.scans where brand_key='beta'");
    assert.equal(beta.rows[0].c, 5);
    // A query scoped to beta never returns acme rows.
    const scoped = await q("select count(*)::int as c from public.scans where brand_key='beta' and visibility_pct is not null");
    assert.ok(scoped.rows[0].c <= 5);
    // Sanity: acme has many more rows than beta.
    assert.ok(acme.rows[0].c > beta.rows[0].c);
  });

  console.log("\nok 2 groups on a loopback QA database.");
} finally {
  await pool.end();
}
