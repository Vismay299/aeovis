#!/usr/bin/env node
// F23 phase 1 database contract: reports, report templates, race-safe share
// tokens and anonymous daily share views. Only a disposable loopback QA/UAT
// database is accepted. Never production: loopback host, _qa/_uat database
// name, and DATABASE_URL refused. Connection settings come from the PG* env
// vars.
//
// Usage:
//   PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=aeovis_f23_qa node scripts/qa/check-f23-db.mjs
//   ... check-f23-db.mjs --group reports
//   ... check-f23-db.mjs --fresh   (rebuild schemas, apply every migration in
//                                   lexical order as CI does, then run all groups)
//
// Groups: schema, reports, sharing, views, retention, rls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
)
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const F23_MIGRATIONS = ["150_f23_reports.sql", "151_f23_report_share_views.sql"];
const FRESH = process.argv.includes("--fresh");
const groupFlagIdx = process.argv.indexOf("--group");
const targetGroup = groupFlagIdx !== -1 ? process.argv[groupFlagIdx + 1] : null;
const pool = new pg.Pool({ max: 4 });
const passed = [];
const id = () => randomUUID();
let current = null;

const HTML = "<!doctype html>\n<html><body><p>QA report</p></body></html>";

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");

/** A 32-character base64url token, shaped like the service's mint. */
function token32() {
  return `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`.slice(0, 32);
}

function dayOffset(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function runGroup(name, fn) {
  if (targetGroup && targetGroup !== name) return;
  current = name;
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
      /* keep the test failure */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function freshDatabase() {
  const bootstrap = read("tests/supabase-bootstrap.sql");
  const roleStatements = [...bootstrap.matchAll(/^CREATE ROLE [^;]+;$/gm)].map((m) => m[0]);
  const rest = bootstrap.replace(/^CREATE ROLE [^;]+;$/gm, "");
  for (const statement of roleStatements) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (error.code !== "42710") throw error;
    }
  }
  await pool.query("drop schema if exists auth cascade");
  await pool.query("drop schema if exists storage cascade");
  await pool.query("drop schema if exists public cascade");
  await pool.query("create schema public");
  await pool.query(rest);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes(F23_MIGRATIONS[0]), "migration 150 must be on disk");
  assert.ok(files.includes(F23_MIGRATIONS[1]), "migration 151 must be on disk");
  for (const file of files) {
    try {
      await pool.query(readFileSync(path.join(MIGRATIONS, file), "utf8"));
    } catch (error) {
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
  }
  console.log(`fresh: applied ${files.length} migrations in lexical order`);
}

async function raises(client, fn, pattern) {
  await client.query("SAVEPOINT f23_expect_error");
  try {
    await fn();
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT f23_expect_error");
    assert.match(String(error.message), pattern);
    return error;
  }
  await client.query("RELEASE SAVEPOINT f23_expect_error");
  assert.fail(`expected the database to raise ${pattern}`);
}

async function makeActor(client, label) {
  const userId = id();
  const brandKey = `qa-f23-${label}-${id()}.example`;
  await client.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [
    userId,
    `${label}-${userId}@example.test`,
  ]);
  await client.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host) VALUES($1,$2,$3,$4)",
    [brandKey, `F23 QA ${label}`, `https://${brandKey}`, brandKey]
  );
  return { userId, brandKey };
}

async function addMember(client, brandKey, userId, role = "member") {
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,$3)",
    [userId, brandKey, role]
  );
}

async function makeReport(
  client,
  {
    brandKey,
    userId,
    title = `QA report ${id()}`,
    summary = "Synthetic QA summary.",
    html = HTML,
    sizeBytes = null,
    shared = false,
    skill = null,
    sanitizerVersion = 1,
  }
) {
  const reportId = id();
  const shareToken = shared ? token32() : null;
  await client.query(
    `INSERT INTO public.reports
       (id,brand_key,title,summary,html,size_bytes,sanitizer_version,skill,created_by,created_by_user_id,share_token,shared_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'assistant',$9,$10,$11)`,
    [
      reportId,
      brandKey,
      title,
      summary,
      html,
      sizeBytes ?? Buffer.byteLength(html, "utf8"),
      sanitizerVersion,
      skill,
      userId ?? null,
      shareToken,
      shared ? new Date().toISOString() : null,
    ]
  );
  return { reportId, shareToken };
}

async function makeTemplate(client, { brandKey, userId, name = `Template ${id()}` }) {
  const templateId = id();
  await client.query(
    `INSERT INTO public.report_templates(id,brand_key,name,description,instructions,created_by,created_by_user_id)
     VALUES($1,$2,$3,'A synthetic brief.','Audience: QA.',$4,$5)`,
    [templateId, brandKey, name, "assistant", userId ?? null]
  );
  return templateId;
}

async function hasTablePrivilege(client, role, table, privilege) {
  const { rows } = await client.query("SELECT has_table_privilege($1,$2,$3) AS ok", [
    role,
    `public.${table}`,
    privilege,
  ]);
  return rows[0].ok;
}

async function rlsCounts(client, userId) {
  await client.query("RESET ROLE");
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
  const counts = {};
  for (const table of ["reports", "report_templates", "report_share_views"]) {
    const idColumn = table === "report_share_views" ? "report_id" : "id";
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, coalesce(array_agg(${idColumn}::text),'{}') AS ids FROM public.${table}`
    );
    counts[table] = { n: rows[0].n, ids: rows[0].ids };
  }
  return counts;
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

async function schema(client) {
  // The second application lands after migration 170 on disk, which is what a
  // re-run by the migration runner actually does. Both applications must pass.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const file of F23_MIGRATIONS) {
      try {
        await client.query(read("supabase/migrations", file));
      } catch (error) {
        throw new Error(`${file} application ${pass + 1} failed: ${error.message}`);
      }
    }
  }

  const tables = ["reports", "report_templates", "report_share_views"];
  for (const table of tables) {
    const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
    assert.equal(rows[0].ok, true, `missing table ${table}`);
    const rls = await client.query("SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass", [
      `public.${table}`,
    ]);
    assert.equal(rls.rows[0].relrowsecurity, true, `${table} must have RLS enabled`);
  }

  const columns = {
    reports: [
      "id", "brand_key", "title", "summary", "html", "size_bytes", "sanitizer_version",
      "skill", "skill_version", "template_id", "session_id", "created_by",
      "created_by_user_id", "share_token", "shared_at", "shared_by", "created_at", "updated_at",
    ],
    report_templates: [
      "id", "brand_key", "name", "description", "instructions", "created_by",
      "created_by_user_id", "created_at", "updated_at",
    ],
    report_share_views: ["report_id", "brand_key", "day", "share_pseudonym", "browser_views", "other_views"],
  };
  for (const [table, expected] of Object.entries(columns)) {
    const { rows } = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
      [table]
    );
    assert.deepEqual(
      rows.map((row) => row.column_name).sort(),
      [...expected].sort(),
      `${table} columns must match §6.1`
    );
  }

  const functions = [
    "public.set_report_share_token(uuid,text,text,uuid)",
    "public.clear_report_share_token(uuid,text)",
    "public.get_shared_report(text)",
    "public.report_workspace_usage(text)",
    "public.record_report_view(uuid,text,text,boolean)",
    "public.prune_report_share_views(date,integer)",
    "public.reports_touch_content()",
  ];
  for (const fn of functions) {
    const { rows } = await client.query("SELECT to_regprocedure($1) IS NOT NULL AS ok", [fn]);
    assert.equal(rows[0].ok, true, `missing function ${fn}`);
    if (fn.endsWith("reports_touch_content()")) continue;
    const exec = await client.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS ok", [fn]);
    assert.equal(exec.rows[0].ok, true, `service_role cannot execute ${fn}`);
    const denied = await client.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS ok", [fn]);
    assert.equal(denied.rows[0].ok, false, `authenticated must not execute ${fn}`);
    const anon = await client.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS ok", [fn]);
    assert.equal(anon.rows[0].ok, false, `anon must not execute ${fn}`);
  }

  const indexes = [
    "reports_title_idx",
    "reports_share_token_idx",
    "reports_list_idx",
    "report_templates_name_idx",
    "report_share_views_day_idx",
  ];
  for (const index of indexes) {
    const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${index}`]);
    assert.equal(rows[0].ok, true, `missing index ${index}`);
  }

  const policies = [
    ["reports", "reports_read"],
    ["report_templates", "report_templates_read"],
    ["report_share_views", "report_share_views_read"],
  ];
  for (const [table, policy] of policies) {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname=$2 AND cmd='SELECT'",
      [table, policy]
    );
    assert.equal(rows[0].n, 1, `missing or non-SELECT policy ${policy}`);
  }

  const triggers = [
    ["reports", "reports_touch"],
    ["report_templates", "report_templates_touch"],
  ];
  for (const [table, trigger] of triggers) {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND NOT tgisinternal",
      [`public.${table}`, trigger]
    );
    assert.equal(rows[0].n, 1, `missing trigger ${trigger}`);
  }

  // The two composite checks §6.1 relies on, read back from the catalog.
  const { rows: checks } = await client.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.reports'::regclass AND contype='c'"
  );
  const definitions = checks.map((row) => row.definition).join("\n");
  assert.match(definitions, /octet_length\(html\) = size_bytes/);
  assert.match(definitions, /share_token IS NULL\) = \(shared_at IS NULL/);

  for (const table of tables) {
    assert.equal(await hasTablePrivilege(client, "authenticated", table, "SELECT"), true, `authenticated must read ${table}`);
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      assert.equal(
        await hasTablePrivilege(client, "authenticated", table, privilege),
        false,
        `authenticated must not ${privilege} ${table}`
      );
    }
    assert.equal(await hasTablePrivilege(client, "service_role", table, "SELECT"), true, `service_role must read ${table}`);
    assert.equal(await hasTablePrivilege(client, "service_role", table, "INSERT"), true, `service_role must write ${table}`);
    assert.equal(await hasTablePrivilege(client, "anon", table, "SELECT"), false, `anon must not read ${table}`);
  }
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

async function reports(client) {
  const actor = await makeActor(client, "reports");
  const { reportId } = await makeReport(client, actor);

  const stored = await client.query(
    "SELECT octet_length(html) AS bytes, size_bytes, sanitizer_version, created_by FROM public.reports WHERE id=$1",
    [reportId]
  );
  assert.equal(stored.rows[0].bytes, stored.rows[0].size_bytes, "size_bytes must equal octet_length(html)");
  assert.equal(stored.rows[0].sanitizer_version, 1);
  assert.equal(stored.rows[0].created_by, "assistant");

  // Unique title per workspace, not globally.
  const seededTitle = (await client.query("SELECT title FROM public.reports WHERE id=$1", [reportId])).rows[0].title;
  await raises(client, () => makeReport(client, { ...actor, title: seededTitle }), /duplicate key|reports_title_idx/);
  const other = await makeActor(client, "reports-other");
  await makeReport(client, { ...other, title: seededTitle });

  // The size check is a real constraint, not a service convention.
  await raises(
    client,
    () => makeReport(client, { ...actor, sizeBytes: Buffer.byteLength(HTML, "utf8") + 1 }),
    /violates check constraint/
  );
  await raises(client, () => makeReport(client, { ...actor, sizeBytes: 0 }), /violates check constraint/);

  // Another workspace's id does not resolve.
  const foreignRead = await client.query("SELECT count(*)::int AS n FROM public.reports WHERE id=$1 AND brand_key=$2", [
    reportId,
    other.brandKey,
  ]);
  assert.equal(foreignRead.rows[0].n, 0);

  // The content trigger: updated_at moves for content, not for sharing.
  await client.query("UPDATE public.reports SET updated_at='2020-01-01T00:00:00Z' WHERE id=$1", [reportId]);
  await client.query("UPDATE public.reports SET summary='A new summary.' WHERE id=$1", [reportId]);
  const bumped = await client.query("SELECT updated_at > '2020-01-01T00:00:00Z'::timestamptz AS ok FROM public.reports WHERE id=$1", [
    reportId,
  ]);
  assert.equal(bumped.rows[0].ok, true, "a content update bumps updated_at");

  await client.query("UPDATE public.reports SET updated_at='2020-01-01T00:00:00Z' WHERE id=$1", [reportId]);
  await client.query(
    "UPDATE public.reports SET share_token=$2, shared_at=now() WHERE id=$1",
    [reportId, token32()]
  );
  const notBumped = await client.query(
    "SELECT updated_at = '2020-01-01T00:00:00Z'::timestamptz AS ok FROM public.reports WHERE id=$1",
    [reportId]
  );
  assert.equal(notBumped.rows[0].ok, true, "a share change must not bump updated_at");

  // Attribution is restored on every update, and created_at never moves.
  const before = await client.query("SELECT created_by, created_by_user_id, created_at FROM public.reports WHERE id=$1", [
    reportId,
  ]);
  await client.query(
    "UPDATE public.reports SET created_by='app', created_by_user_id=NULL, created_at='2020-01-01T00:00:00Z' WHERE id=$1",
    [reportId]
  );
  const after = await client.query("SELECT created_by, created_by_user_id, created_at FROM public.reports WHERE id=$1", [
    reportId,
  ]);
  assert.deepEqual(after.rows[0], before.rows[0], "attribution is immutable");

  // The share pair is one fact, not two.
  await raises(
    client,
    () => client.query("UPDATE public.reports SET share_token=NULL WHERE id=$1", [reportId]),
    /violates check constraint/
  );
  const privateReport = await makeReport(client, { ...actor, title: `Private ${id()}` });
  await raises(
    client,
    () => client.query("UPDATE public.reports SET shared_at=now() WHERE id=$1", [privateReport.reportId]),
    /violates check constraint/
  );

  // Skill slugs and versions are constrained.
  await raises(client, () => makeReport(client, { ...actor, skill: "Not A Slug" }), /violates check constraint/);

  const usage = await client.query("SELECT * FROM public.report_workspace_usage($1)", [actor.brandKey]);
  const mine = await client.query("SELECT count(*)::int AS n, sum(size_bytes)::bigint AS bytes FROM public.reports WHERE brand_key=$1", [
    actor.brandKey,
  ]);
  assert.equal(Number(usage.rows[0].report_count), mine.rows[0].n);
  assert.equal(Number(usage.rows[0].total_bytes), Number(mine.rows[0].bytes));

  // The public read returns the report and the workspace state.
  const shared = await makeReport(client, { ...actor, shared: true, title: `Shared ${id()}` });
  const readBack = await client.query("SELECT * FROM public.get_shared_report($1)", [shared.shareToken]);
  assert.equal(readBack.rows.length, 1);
  assert.equal(readBack.rows[0].id, shared.reportId);
  assert.equal(readBack.rows[0].brand_key, actor.brandKey);
  assert.equal(readBack.rows[0].website_host, actor.brandKey);
  assert.equal(readBack.rows[0].workspace_active, true);
  await client.query("UPDATE public.customer_brands SET is_active=false WHERE brand_key=$1", [actor.brandKey]);
  const inactive = await client.query("SELECT workspace_active FROM public.get_shared_report($1)", [shared.shareToken]);
  assert.equal(inactive.rows[0].workspace_active, false);
  await client.query("UPDATE public.customer_brands SET is_active=true WHERE brand_key=$1", [actor.brandKey]);
  const unknown = await client.query("SELECT count(*)::int AS n FROM public.get_shared_report($1)", ["x".repeat(32)]);
  assert.equal(unknown.rows[0].n, 0);
}

// ---------------------------------------------------------------------------
// sharing
// ---------------------------------------------------------------------------

async function sharing(client) {
  const actor = await makeActor(client, "sharing");
  const { reportId } = await makeReport(client, actor);

  const firstToken = token32();
  const first = await client.query("SELECT * FROM public.set_report_share_token($1,$2,$3,$4)", [
    reportId,
    actor.brandKey,
    firstToken,
    actor.userId,
  ]);
  assert.deepEqual(
    { share_token: first.rows[0].share_token, created: first.rows[0].created },
    { share_token: firstToken, created: true }
  );
  assert.ok(first.rows[0].shared_at);

  const secondToken = token32();
  const second = await client.query("SELECT * FROM public.set_report_share_token($1,$2,$3,$4)", [
    reportId,
    actor.brandKey,
    secondToken,
    actor.userId,
  ]);
  assert.equal(second.rows[0].share_token, firstToken, "the first token wins");
  assert.equal(second.rows[0].created, false);

  assert.equal(
    (await client.query("SELECT public.clear_report_share_token($1,$2) AS ok", [reportId, actor.brandKey])).rows[0].ok,
    true
  );
  assert.equal(
    (await client.query("SELECT public.clear_report_share_token($1,$2) AS ok", [reportId, actor.brandKey])).rows[0].ok,
    false,
    "a second revoke is a no-op"
  );
  const cleared = await client.query("SELECT share_token, shared_at FROM public.reports WHERE id=$1", [reportId]);
  assert.deepEqual(cleared.rows[0], { share_token: null, shared_at: null });

  const thirdToken = token32();
  const third = await client.query("SELECT * FROM public.set_report_share_token($1,$2,$3,$4)", [
    reportId,
    actor.brandKey,
    thirdToken,
    actor.userId,
  ]);
  assert.equal(third.rows[0].created, true);
  assert.notEqual(third.rows[0].share_token, firstToken, "re-sharing mints a different token");

  const foreign = await makeActor(client, "sharing-foreign");
  await raises(
    client,
    () => client.query("SELECT * FROM public.set_report_share_token($1,$2,$3,$4)", [reportId, foreign.brandKey, token32(), foreign.userId]),
    /report_not_found/
  );
  await raises(
    client,
    () => client.query("SELECT public.clear_report_share_token($1,$2)", [reportId, foreign.brandKey]),
    /report_not_found/
  );

  // The race: two publishers on two connections, one row, no lock of our own.
  // Both must end up with the same token and exactly one must report created.
  const raceBrand = `qa-f23-race-${id()}.example`;
  const raceUser = id();
  const raceReport = id();
  await pool.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [
    raceUser,
    `race-${raceUser}@example.test`,
  ]);
  await pool.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host) VALUES($1,$1,$2,$1)",
    [raceBrand, `https://${raceBrand}`]
  );
  try {
    await pool.query(
      `INSERT INTO public.reports(id,brand_key,title,summary,html,size_bytes,sanitizer_version,created_by,created_by_user_id)
       VALUES($1,$2,'Race report','Race summary.',$3,octet_length($3),1,'assistant',$4)`,
      [raceReport, raceBrand, HTML, raceUser]
    );
    const [left, right] = await Promise.all([
      pool.connect(),
      pool.connect(),
    ]);
    try {
      const raceToken = token32();
      const outcomes = await Promise.all([
        left.query("SELECT * FROM public.set_report_share_token($1,$2,$3,$4)", [raceReport, raceBrand, raceToken, raceUser]),
        right.query("SELECT * FROM public.set_report_share_token($1,$2,$3,$4)", [raceReport, raceBrand, raceToken, raceUser]),
      ]);
      const tokens = outcomes.map((outcome) => outcome.rows[0].share_token);
      const created = outcomes.filter((outcome) => outcome.rows[0].created === true).length;
      assert.equal(new Set(tokens).size, 1, "both publishers must see the same token");
      assert.equal(created, 1, "exactly one publisher creates the link");
    } finally {
      left.release();
      right.release();
    }
  } finally {
    await pool.query("DELETE FROM public.customer_brands WHERE brand_key=$1", [raceBrand]);
    await pool.query("DELETE FROM auth.users WHERE id=$1", [raceUser]);
  }
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

async function views(client) {
  const actor = await makeActor(client, "views");
  const { reportId } = await makeReport(client, actor);
  const pseudonym = "share:0123456789abcdef";
  const other = "share:fedcba9876543210";

  await client.query("SELECT public.record_report_view($1,$2,$3,true)", [reportId, actor.brandKey, pseudonym]);
  await client.query("SELECT public.record_report_view($1,$2,$3,true)", [reportId, actor.brandKey, pseudonym]);
  await client.query("SELECT public.record_report_view($1,$2,$3,false)", [reportId, actor.brandKey, pseudonym]);
  await client.query("SELECT public.record_report_view($1,$2,$3,true)", [reportId, actor.brandKey, other]);

  const today = await client.query("SELECT (now() AT TIME ZONE 'utc')::date::text AS day");
  const rows = await client.query(
    "SELECT day::text, share_pseudonym, browser_views, other_views FROM public.report_share_views WHERE report_id=$1 ORDER BY share_pseudonym",
    [reportId]
  );
  assert.deepEqual(rows.rows, [
    { day: today.rows[0].day, share_pseudonym: pseudonym, browser_views: 2, other_views: 1 },
    { day: today.rows[0].day, share_pseudonym: other, browser_views: 1, other_views: 0 },
  ]);

  // A malformed pseudonym is refused by the check constraint.
  await raises(
    client,
    () => client.query("SELECT public.record_report_view($1,$2,'not-a-pseudonym',true)", [reportId, actor.brandKey]),
    /violates check constraint/
  );

  // Prune takes a date and only removes rows strictly before it.
  await client.query(
    "INSERT INTO public.report_share_views(report_id,brand_key,day,share_pseudonym) VALUES($1,$2,$3,'share:1111111111111111')",
    [reportId, actor.brandKey, dayOffset(-2)]
  );
  const pruned = await client.query("SELECT public.prune_report_share_views($1, 5000) AS n", [dayOffset(-1)]);
  assert.equal(pruned.rows[0].n, 1);
  const left = await client.query("SELECT count(*)::int AS n FROM public.report_share_views WHERE report_id=$1", [reportId]);
  assert.equal(left.rows[0].n, 2, "today's rows stay");

  // A short batch and a capped batch both behave.
  const oldPseudonyms = ["share:dddddddddddddddd", "share:eeeeeeeeeeeeeeee", "share:ffffffffffffffff"];
  for (const [index, pseudonym] of oldPseudonyms.entries()) {
    await client.query(
      "INSERT INTO public.report_share_views(report_id,brand_key,day,share_pseudonym) VALUES($1,$2,$3,$4)",
      [reportId, actor.brandKey, dayOffset(-10 - index), pseudonym]
    );
  }
  const capped = await client.query("SELECT public.prune_report_share_views($1, 2) AS n", [dayOffset(-1)]);
  assert.equal(capped.rows[0].n, 2);
  const remaining = await client.query(
    "SELECT count(*)::int AS n FROM public.report_share_views WHERE report_id=$1 AND day < $2",
    [reportId, dayOffset(-1)]
  );
  assert.equal(remaining.rows[0].n, 1);

  // Deleting the report cascades its view rows.
  await client.query("DELETE FROM public.reports WHERE id=$1", [reportId]);
  const cascaded = await client.query("SELECT count(*)::int AS n FROM public.report_share_views WHERE report_id=$1", [
    reportId,
  ]);
  assert.equal(cascaded.rows[0].n, 0);
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

async function retention(client) {
  const actor = await makeActor(client, "retention");
  const { reportId } = await makeReport(client, actor);
  const templateId = await makeTemplate(client, actor);

  const oldDay = dayOffset(-396);
  const recentDay = dayOffset(-100);
  const boundaryDay = dayOffset(-395);
  await client.query(
    "INSERT INTO public.report_share_views(report_id,brand_key,day,share_pseudonym) VALUES($1,$2,$3,'share:aaaaaaaaaaaaaaaa')",
    [reportId, actor.brandKey, oldDay]
  );
  await client.query(
    "INSERT INTO public.report_share_views(report_id,brand_key,day,share_pseudonym) VALUES($1,$2,$3,'share:bbbbbbbbbbbbbbbb')",
    [reportId, actor.brandKey, recentDay]
  );
  await client.query(
    "INSERT INTO public.report_share_views(report_id,brand_key,day,share_pseudonym) VALUES($1,$2,$3,'share:cccccccccccccccc')",
    [reportId, actor.brandKey, boundaryDay]
  );

  const pruned = await client.query("SELECT public.prune_report_share_views($1, 5000) AS n", [dayOffset(-395)]);
  assert.equal(pruned.rows[0].n, 1, "only the row older than 395 days is pruned");
  const kept = await client.query(
    "SELECT count(*)::int AS n FROM public.report_share_views WHERE report_id=$1",
    [reportId]
  );
  assert.equal(kept.rows[0].n, 2, "the 395-day boundary row and the recent row stay");
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM public.reports WHERE id=$1", [reportId])).rows[0].n,
    1,
    "reports are kept until deleted"
  );
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM public.report_templates WHERE id=$1", [templateId])).rows[0].n,
    1,
    "templates are kept until deleted"
  );
}

// ---------------------------------------------------------------------------
// rls
// ---------------------------------------------------------------------------

async function rls(client) {
  const workspaceA = await makeActor(client, "rls-a");
  await addMember(client, workspaceA.brandKey, workspaceA.userId, "owner");
  const a2 = { userId: id(), brandKey: workspaceA.brandKey };
  await client.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [
    a2.userId,
    `a2-${a2.userId}@example.test`,
  ]);
  await addMember(client, workspaceA.brandKey, a2.userId);
  const workspaceB = await makeActor(client, "rls-b");
  await addMember(client, workspaceB.brandKey, workspaceB.userId, "owner");

  const seeded = {};
  for (const [label, actor] of [["a1", workspaceA], ["b1", workspaceB]]) {
    const report = await makeReport(client, { ...actor, title: `RLS ${label} report`, shared: true });
    const templateId = await makeTemplate(client, { ...actor, name: `RLS ${label} template` });
    await client.query(
      "INSERT INTO public.report_share_views(report_id,brand_key,day,share_pseudonym) VALUES($1,$2,$3,$4)",
      [report.reportId, actor.brandKey, dayOffset(0), `share:${label === "a1" ? "a" : "b"}`.padEnd(22, "0").slice(0, 22)]
    );
    seeded[label] = { reportId: report.reportId, templateId, userId: actor.userId };
  }

  const a1 = await rlsCounts(client, seeded.a1.userId);
  assert.equal(a1.reports.n, 1);
  assert.deepEqual(a1.reports.ids, [seeded.a1.reportId]);
  assert.equal(a1.report_templates.n, 1);
  assert.deepEqual(a1.report_templates.ids, [seeded.a1.templateId]);
  assert.equal(a1.report_share_views.n, 1);
  assert.deepEqual(a1.report_share_views.ids, [seeded.a1.reportId]);

  const a2Counts = await rlsCounts(client, a2.userId);
  assert.equal(a2Counts.reports.n, 1);
  assert.deepEqual(a2Counts.reports.ids, [seeded.a1.reportId], "a member reads the workspace's reports");
  assert.deepEqual(a2Counts.report_templates.ids, [seeded.a1.templateId]);

  const b1 = await rlsCounts(client, seeded.b1.userId);
  assert.equal(b1.reports.n, 1);
  assert.deepEqual(b1.reports.ids, [seeded.b1.reportId]);
  assert.equal(b1.reports.ids.includes(seeded.a1.reportId), false, "workspace B must not read A's report");
  assert.deepEqual(b1.report_templates.ids, [seeded.b1.templateId]);
  assert.equal(b1.reports.ids.includes(seeded.a1.templateId), false);

  await client.query("RESET ROLE");
  await client.query("SET LOCAL ROLE anon");
  for (const table of ["reports", "report_templates", "report_share_views"]) {
    await raises(client, () => client.query(`SELECT count(*) FROM public.${table}`), /permission denied/);
  }
  await client.query("RESET ROLE");

  // The service role sees and writes everything.
  await client.query("SET LOCAL ROLE service_role");
  const all = await client.query("SELECT count(*)::int AS n FROM public.reports");
  assert.ok(all.rows[0].n >= 2);
  const written = await makeReport(client, {
    brandKey: workspaceA.brandKey,
    userId: workspaceA.userId,
  });
  assert.ok(written.reportId);
  await client.query("RESET ROLE");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const GROUPS = { schema, reports, sharing, views, retention, rls };

try {
  if (targetGroup && !GROUPS[targetGroup]) {
    throw new Error(`unknown group "${targetGroup}"; known groups: ${Object.keys(GROUPS).join(", ")}`);
  }
  if (FRESH) {
    await freshDatabase();
  } else if (!targetGroup || targetGroup === "schema") {
    const { rows } = await pool.query("SELECT to_regclass('public.reports') IS NOT NULL AS ok");
    if (!rows[0].ok) await freshDatabase();
  }
  for (const [name, fn] of Object.entries(GROUPS)) {
    await runGroup(name, fn);
  }
  console.log("all groups passed");
  await pool.end();
} catch (error) {
  console.error(`FAIL ${current ?? "(setup)"}: ${error.message}`);
  try {
    await pool.end();
  } catch {
    /* ignore a second close */
  }
  process.exitCode = 1;
}
