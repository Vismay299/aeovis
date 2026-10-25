#!/usr/bin/env node
// Portions ported from every-app/open-seo@c5f8db19c7ca9e750836b6ed5c8a6491d4f967f4 (MIT, © 2026 Ben Senescu):
//   src/server/features/project-context/repositories/ProjectContextRepository.query.test.ts:79-156
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
) {
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
}

const pool = new pg.Pool({ max: 1 });
const passed = [];
const id = () => crypto.randomUUID();

async function group(name, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("ROLLBACK");
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* retain the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function makeBrand(client, suffix, userId = null) {
  const brandKey = `qa-f07-${suffix}-${id()}.example`;
  await client.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host,aliases) VALUES($1,$2,$3,$4,$5)",
    [brandKey, `F07 ${suffix}`, `https://${brandKey}`, brandKey, []],
  );
  if (userId) {
    await client.query("INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner')", [userId, brandKey]);
  }
  return brandKey;
}

async function makeUser(client, email) {
  const userId = id();
  await client.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [userId, email]);
  return userId;
}

async function applyOps(client, brandKey, ops, author = "system", actor = null) {
  const { rows } = await client.query(
    "SELECT public.apply_project_context_ops($1,$2::jsonb,$3,$4) AS result",
    [brandKey, JSON.stringify(ops), author, actor],
  );
  return rows[0].result;
}

async function setUser(client, userId) {
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
}

async function expectDenied(client, savepoint, sql, values = []) {
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught;
  try {
    await client.query(sql, values);
  } catch (error) {
    caught = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  assert.ok(caught, "operation unexpectedly succeeded");
  assert.equal(caught.code, "42501", "expected a PostgreSQL permission denial");
}

async function main() {
  await group("rls", async (client) => {
    const userA = await makeUser(client, `${id()}@f07.test`);
    const userB = await makeUser(client, `${id()}@f07.test`);
    const brandA = await makeBrand(client, "rls-a", userA);
    const brandB = await makeBrand(client, "rls-b", userB);

    await client.query("SET LOCAL ROLE service_role");
    for (const [brandKey, tag, actor] of [[brandA, "a", userA], [brandB, "b", userB]]) {
      const result = await applyOps(client, brandKey, [
        { kind: "upsert_section", key: "business_overview", title: null, content: `Workspace ${tag}` },
        { kind: "upsert_competitors", rows: [{ domain: `competitor-${tag}.example`, name: null, notes: null, source: "manual", source_url: null }] },
        { kind: "upsert_key_pages", rows: [{ url: `https://${tag}.example/page`, role: "other", topic: null, notes: null }] },
        { kind: "append_research_log", research_kind: "note", research_key: null, summary: `Research ${tag}`, spend_usd: null, job_id: null },
      ], "user", actor);
      assert.deepEqual(result, { applied: 4 });
    }
    await client.query(
      "INSERT INTO public.project_memory_state(brand_key,brief_import_checked_at,brief_imported) VALUES($1,now(),false),($2,now(),false)",
      [brandA, brandB],
    );

    await setUser(client, userA);
    for (const table of ["project_context_sections", "project_competitors", "project_key_pages", "project_research_log"]) {
      const result = await client.query(`SELECT brand_key FROM public.${table}`);
      assert.deepEqual(result.rows.map((row) => row.brand_key), [brandA], `${table} leaked or hid tenant A rows`);
    }
    const stateA = await client.query("SELECT brand_key FROM public.project_memory_state");
    assert.deepEqual(stateA.rows.map((row) => row.brand_key), [brandA], "project_memory_state leaked or hid tenant A rows");
    await expectDenied(
      client,
      "f07_customer_write",
      "INSERT INTO public.project_context_sections(brand_key,key,content,updated_by) VALUES($1,'current_goal','No direct writes','user')",
      [brandA],
    );

    await setUser(client, userB);
    for (const table of ["project_context_sections", "project_competitors", "project_key_pages", "project_research_log"]) {
      const result = await client.query(`SELECT brand_key FROM public.${table}`);
      assert.deepEqual(result.rows.map((row) => row.brand_key), [brandB], `${table} leaked or hid tenant B rows`);
    }
    const stateB = await client.query("SELECT brand_key FROM public.project_memory_state");
    assert.deepEqual(stateB.rows.map((row) => row.brand_key), [brandB], "project_memory_state leaked or hid tenant B rows");

    await client.query("SET LOCAL ROLE anon");
    for (const table of ["project_context_sections", "project_competitors", "project_key_pages", "project_research_log", "project_memory_state"]) {
      await expectDenied(client, `f07_anon_${table}`, `SELECT * FROM public.${table}`);
    }
    const rls = await client.query(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[])",
      [["project_context_sections", "project_competitors", "project_key_pages", "project_research_log", "project_memory_state"]],
    );
    assert.equal(rls.rows.length, 5);
    assert.ok(rls.rows.every((row) => row.relrowsecurity === true), "all five F07 tables must have RLS enabled");
  });

  await group("atomic", async (client) => {
    const brandKey = await makeBrand(client, "atomic");
    const rows = Array.from({ length: 101 }, (_, index) => ({
      domain: `competitor-${index}.example`,
      name: null,
      notes: null,
      source: "manual",
      source_url: null,
    }));
    await client.query("SET LOCAL ROLE service_role");
    await client.query("SAVEPOINT f07_overflow");
    let caught;
    try {
      await applyOps(client, brandKey, [
        { kind: "upsert_section", key: "business_overview", title: null, content: "This must roll back" },
        { kind: "upsert_competitors", rows },
      ]);
    } catch (error) {
      caught = error;
    }
    await client.query("ROLLBACK TO SAVEPOINT f07_overflow");
    assert.ok(caught, "101st competitor unexpectedly succeeded");
    assert.match(caught.message, /project_memory_cap:competitors/);
    const counts = await client.query(
      "SELECT (SELECT count(*) FROM public.project_competitors WHERE brand_key=$1)::int AS competitors, (SELECT count(*) FROM public.project_context_sections WHERE brand_key=$1)::int AS sections",
      [brandKey],
    );
    assert.deepEqual(counts.rows[0], { competitors: 0, sections: 0 }, "rejected batch left partial rows behind");

    const customOps = [
      { kind: "upsert_section", key: "business_overview", title: null, content: "This custom-section batch must roll back" },
      ...Array.from({ length: 21 }, (_, index) => ({
        kind: "upsert_section",
        key: `custom:qa-section-${index}`,
        title: null,
        content: `Custom section ${index}`,
      })),
    ];
    await client.query("SAVEPOINT f07_custom_section_overflow");
    let customCaught;
    try {
      await applyOps(client, brandKey, customOps);
    } catch (error) {
      customCaught = error;
    }
    await client.query("ROLLBACK TO SAVEPOINT f07_custom_section_overflow");
    assert.ok(customCaught, "21st custom section unexpectedly succeeded");
    assert.match(customCaught.message, /project_memory_cap:custom_sections/);
    const sectionCounts = await client.query(
      "SELECT count(*)::int AS sections, (count(*) FILTER (WHERE key LIKE 'custom:%'))::int AS custom_sections FROM public.project_context_sections WHERE brand_key=$1",
      [brandKey],
    );
    assert.deepEqual(sectionCounts.rows[0], { sections: 0, custom_sections: 0 }, "rejected custom-section batch left rows behind");

    const keyPageOps = [
      { kind: "upsert_section", key: "business_overview", title: null, content: "This key-page batch must roll back" },
      {
        kind: "upsert_key_pages",
        rows: Array.from({ length: 101 }, (_, index) => ({
          url: `https://${brandKey}/page-${index}`,
          role: "other",
          topic: null,
          notes: null,
        })),
      },
    ];
    await client.query("SAVEPOINT f07_key_page_overflow");
    let keyPageCaught;
    try {
      await applyOps(client, brandKey, keyPageOps);
    } catch (error) {
      keyPageCaught = error;
    }
    await client.query("ROLLBACK TO SAVEPOINT f07_key_page_overflow");
    assert.ok(keyPageCaught, "101st key page unexpectedly succeeded");
    assert.match(keyPageCaught.message, /project_memory_cap:key_pages/);
    const keyPageCounts = await client.query(
      "SELECT (SELECT count(*) FROM public.project_key_pages WHERE brand_key=$1)::int AS key_pages, (SELECT count(*) FROM public.project_context_sections WHERE brand_key=$1)::int AS sections",
      [brandKey],
    );
    assert.deepEqual(keyPageCounts.rows[0], { key_pages: 0, sections: 0 }, "rejected key-page batch left partial rows behind");
  });

  await group("coalesce", async (client) => {
    const brandKey = await makeBrand(client, "coalesce");
    await client.query("SET LOCAL ROLE service_role");
    await applyOps(client, brandKey, [
      { kind: "upsert_section", key: "custom:priority", title: "Saved title", content: "Original" },
      { kind: "upsert_competitors", rows: [
        { domain: "alpha.example", name: "Alpha", notes: "Saved note", source: "setup_research", source_url: "https://alpha.example/about" },
        { domain: "beta.example", name: "Beta", notes: "Beta note", source: "manual", source_url: null },
      ] },
      { kind: "upsert_key_pages", rows: [
        { url: "https://coalesce.example/money", role: "money", topic: "Saved topic", notes: "Saved page note" },
      ] },
    ]);
    await applyOps(client, brandKey, [
      { kind: "upsert_section", key: "custom:priority", title: null, content: "Updated" },
      { kind: "upsert_competitors", rows: [
        { domain: "alpha.example", name: null, notes: null, source: "manual", source_url: null },
      ] },
      { kind: "upsert_key_pages", rows: [
        { url: "https://coalesce.example/money", role: null, topic: null, notes: null },
        { url: "https://coalesce.example/new", role: null, topic: null, notes: null },
      ] },
    ]);

    const section = await client.query("SELECT title,content FROM public.project_context_sections WHERE brand_key=$1 AND key='custom:priority'", [brandKey]);
    assert.deepEqual(section.rows[0], { title: "Saved title", content: "Updated" });
    const competitors = await client.query(
      "SELECT domain,name,notes,source,source_url FROM public.project_competitors WHERE brand_key=$1 ORDER BY domain",
      [brandKey],
    );
    assert.deepEqual(competitors.rows, [
      { domain: "alpha.example", name: "Alpha", notes: "Saved note", source: "setup_research", source_url: "https://alpha.example/about" },
      { domain: "beta.example", name: "Beta", notes: "Beta note", source: "manual", source_url: null },
    ]);
    const pages = await client.query(
      "SELECT url,role,topic,notes FROM public.project_key_pages WHERE brand_key=$1 ORDER BY url",
      [brandKey],
    );
    assert.deepEqual(pages.rows, [
      { url: "https://coalesce.example/money", role: "money", topic: "Saved topic", notes: "Saved page note" },
      { url: "https://coalesce.example/new", role: "other", topic: null, notes: null },
    ]);
  });

  await group("research", async (client) => {
    const brandKey = await makeBrand(client, "research");
    await client.query("SET LOCAL ROLE service_role");
    await client.query(
      "INSERT INTO public.project_research_log(brand_key,entry_date,kind,research_key,summary,created_by) VALUES($1,(now() AT TIME ZONE 'UTC')::date - 91,'questions.setup','offcult.in','Old research','system')",
      [brandKey],
    );
    await applyOps(client, brandKey, [{
      kind: "append_research_log",
      research_kind: "questions.setup",
      research_key: "offcult.in",
      summary: "Current research",
      spend_usd: 0.0841,
      job_id: null,
      entry_date: "1900-01-01",
    }]);
    const rows = await client.query(
      "SELECT entry_date::text,kind,research_key,summary,spend_usd FROM public.project_research_log WHERE brand_key=$1 ORDER BY created_at DESC",
      [brandKey],
    );
    assert.equal(rows.rows.length, 1, "append must prune the 91-day-old row");
    assert.equal(rows.rows[0].entry_date, new Date().toISOString().slice(0, 10), "entry_date must be server-stamped UTC, ignoring caller data");
    assert.deepEqual(
      { kind: rows.rows[0].kind, research_key: rows.rows[0].research_key, summary: rows.rows[0].summary, spend_usd: Number(rows.rows[0].spend_usd) },
      { kind: "questions.setup", research_key: "offcult.in", summary: "Current research", spend_usd: 0.0841 },
    );
    const found = await client.query(
      "SELECT id FROM public.project_research_log WHERE brand_key=$1 AND kind=$2 AND research_key=$3 AND entry_date >= (now() AT TIME ZONE 'UTC')::date - 90 ORDER BY created_at DESC LIMIT 1",
      [brandKey, "questions.setup", "offcult.in"],
    );
    assert.equal(found.rows.length, 1, "lookup by kind and normalized key must find recent research");
  });

  await group("import-once", async (client) => {
    const brandKey = await makeBrand(client, "import-once");
    await client.query("SET LOCAL ROLE service_role");
    const first = await client.query("SELECT public.claim_project_brief_import($1) AS claimed", [brandKey]);
    const second = await client.query("SELECT public.claim_project_brief_import($1) AS claimed", [brandKey]);
    assert.equal(first.rows[0].claimed, true);
    assert.equal(second.rows[0].claimed, false);
  });

  console.log(`ok ${passed.length} groups`);
}

main()
  .catch((error) => {
    console.error("FAIL F07 database harness");
    console.error(error instanceof Error ? error.message : "Unknown failure");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
