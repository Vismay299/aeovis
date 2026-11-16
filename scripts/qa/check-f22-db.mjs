#!/usr/bin/env node
// F22 Phase 2 database contract: assistant sessions, messages, turns, stream
// chunks, approvals and the read-only Search Console query summary. Only a
// disposable loopback QA/UAT database is accepted. Never production: loopback
// host, _qa/_uat database name, no DATABASE_URL. Connection settings come from
// the PG* env vars.
//
// Usage:
//   PGHOST=127.0.0.1 PGPORT=55441 PGDATABASE=aeovis_f22_qa node scripts/qa/check-f22-db.mjs
//   ... check-f22-db.mjs --group turns
//   ... check-f22-db.mjs --fresh   (rebuild schemas, apply every migration in
//                                  lexical order as CI does, then run all groups)
//
// Groups: schema, turns, rewind, approvals, chunks, gsc, retention, rls.
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
const F22_MIGRATIONS = [
  "145_f22_assistant_sessions.sql",
  "146_f22_assistant_stream_chunks.sql",
  "147_f22_assistant_approvals.sql",
  "148_f22_gsc_query_summary.sql",
];
const FRESH = process.argv.includes("--fresh");
const groupFlagIdx = process.argv.indexOf("--group");
const targetGroup = groupFlagIdx !== -1 ? process.argv[groupFlagIdx + 1] : null;
const pool = new pg.Pool({ max: 4 });
const passed = [];
const id = () => randomUUID();
let current = null;

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");

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
  assert.ok(files.includes(F22_MIGRATIONS[0]), "migration 145 must be on disk");
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
  await client.query("SAVEPOINT f22_expect_error");
  try {
    await fn();
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT f22_expect_error");
    assert.match(String(error.message), pattern);
    return error;
  }
  await client.query("RELEASE SAVEPOINT f22_expect_error");
  assert.fail(`expected the database to raise ${pattern}`);
}

async function makeActor(client, label) {
  const userId = id();
  const brandKey = `qa-f22-${label}-${id()}.example`;
  await client.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [
    userId,
    `${label}-${userId}@example.test`,
  ]);
  await client.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host) VALUES($1,$2,$3,$4)",
    [brandKey, `F22 QA ${label}`, `https://${brandKey}`, brandKey],
  );
  return { userId, brandKey };
}

async function addMember(client, brandKey, userId, role = "member") {
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,$3)",
    [userId, brandKey, role],
  );
}

async function makeSession(client, { brandKey, userId, archivedAt = null, updatedAt = null }) {
  const { rows } = await client.query(
    archivedAt
      ? "INSERT INTO public.assistant_sessions(brand_key,user_id,archived_at,updated_at) VALUES($1,$2,$3,$4) RETURNING id"
      : updatedAt
        ? "INSERT INTO public.assistant_sessions(brand_key,user_id,updated_at) VALUES($1,$2,$3) RETURNING id"
        : "INSERT INTO public.assistant_sessions(brand_key,user_id) VALUES($1,$2) RETURNING id",
    archivedAt
      ? [brandKey, userId, archivedAt, updatedAt ?? archivedAt]
      : updatedAt
        ? [brandKey, userId, updatedAt]
        : [brandKey, userId],
  );
  return rows[0].id;
}

async function makeTurn(client, { sessionId, brandKey, userId, status = "streaming", heartbeatAt = null }) {
  const terminal = status === "streaming" ? null : new Date().toISOString();
  const { rows } = await client.query(
    `INSERT INTO public.assistant_turns(session_id,brand_key,user_id,status,stop_reason,heartbeat_at,finished_at)
     VALUES($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),$7) RETURNING id`,
    [sessionId, brandKey, userId, status, status === "streaming" ? null : status === "interrupted" ? "interrupted" : "finished", heartbeatAt, terminal],
  );
  return rows[0].id;
}

async function makeMessage(client, { sessionId, brandKey, messageId, role = "user", turnId = null, createdAt = null }) {
  await client.query(
    `INSERT INTO public.assistant_messages(session_id,id,brand_key,role,parts,metadata,turn_id,created_at)
     VALUES($1,$2,$3,$4,$5::jsonb,'{}'::jsonb,$6,coalesce($7::timestamptz,now()))`,
    [sessionId, messageId, brandKey, role, JSON.stringify([{ type: "text", text: messageId }]), turnId, createdAt],
  );
}

async function makeApproval(client, {
  sessionId,
  brandKey,
  userId,
  turnId = null,
  kind = "confirm",
  status = "pending",
  createdAt = null,
  expiresAt = null,
  decidedAt = null,
  quote = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO public.assistant_approvals
       (session_id,turn_id,brand_key,user_id,tool_name,tool_call_id,kind,priced_action,input,input_sha256,quote,quoted_usd,
        label,status,decided_at,expires_at,created_at)
     VALUES($1,$2,$3,$4,'list_scans',$5,$6,$7,'{}'::jsonb,$8,$9::jsonb,$10,'List scans',$11,$12,
            coalesce($13::timestamptz,now()+interval '15 minutes'),coalesce($14::timestamptz,now()))
     RETURNING id`,
    [
      sessionId,
      turnId,
      brandKey,
      userId,
      `call-${id()}`,
      kind,
      kind === "price" ? "keywords.research.run" : null,
      "a".repeat(64),
      quote ? JSON.stringify(quote) : null,
      kind === "price" ? 0.25 : null,
      status,
      decidedAt,
      expiresAt,
      createdAt,
    ],
  );
  return rows[0].id;
}

async function hasTablePrivilege(client, role, table, privilege) {
  const { rows } = await client.query("SELECT has_table_privilege($1,$2,$3) AS ok", [role, `public.${table}`, privilege]);
  return rows[0].ok;
}

async function rlsCounts(client, userId) {
  await client.query("RESET ROLE");
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
  const counts = {};
  for (const table of ["assistant_sessions", "assistant_messages", "assistant_turns", "assistant_approvals"]) {
    const { rows } = await client.query(`SELECT count(*)::int AS n, coalesce(array_agg(id::text),'{}') AS ids FROM public.${table}`);
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
    for (const file of F22_MIGRATIONS) {
      try {
        await client.query(read("supabase/migrations", file));
      } catch (error) {
        throw new Error(`${file} application ${pass + 1} failed: ${error.message}`);
      }
    }
  }

  const tables = [
    "assistant_sessions",
    "assistant_messages",
    "assistant_turns",
    "assistant_stream_chunks",
    "assistant_approvals",
  ];
  for (const table of tables) {
    const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
    assert.equal(rows[0].ok, true, `missing table ${table}`);
    const rls = await client.query("SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass", [`public.${table}`]);
    assert.equal(rls.rows[0].relrowsecurity, true, `${table} must have RLS enabled`);
  }

  const functions = [
    "public.begin_assistant_turn(uuid,text,uuid,integer)",
    "public.rewind_assistant_session(uuid,uuid,text)",
    "public.prune_assistant_sessions(timestamptz,integer)",
    "public.prune_assistant_stream_chunks(timestamptz,integer)",
    "public.claim_assistant_approval(uuid,uuid,text,numeric)",
    "public.expire_assistant_approvals(timestamptz,integer)",
    "public.assistant_gsc_query_summary(text,date,numeric,numeric,integer,text,integer)",
  ];
  for (const fn of functions) {
    const { rows } = await client.query("SELECT to_regprocedure($1) IS NOT NULL AS ok", [fn]);
    assert.equal(rows[0].ok, true, `missing function ${fn}`);
    const exec = await client.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS ok", [fn]);
    assert.equal(exec.rows[0].ok, true, `service_role cannot execute ${fn}`);
    const denied = await client.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS ok", [fn]);
    assert.equal(denied.rows[0].ok, false, `authenticated must not execute ${fn}`);
  }

  const indexes = [
    "assistant_sessions_list_idx",
    "assistant_sessions_updated_idx",
    "assistant_messages_order_idx",
    "assistant_turns_one_streaming_idx",
    "assistant_turns_user_idx",
    "assistant_turns_brand_idx",
    "assistant_turns_heartbeat_idx",
    "assistant_approvals_call_idx",
    "assistant_approvals_pending_idx",
    "assistant_approvals_running_idx",
  ];
  for (const index of indexes) {
    const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${index}`]);
    assert.equal(rows[0].ok, true, `missing index ${index}`);
  }

  const policies = [
    ["assistant_sessions", "assistant_sessions_read"],
    ["assistant_messages", "assistant_messages_read"],
    ["assistant_turns", "assistant_turns_read"],
    ["assistant_stream_chunks", "assistant_stream_chunks_read"],
    ["assistant_approvals", "assistant_approvals_read"],
  ];
  for (const [table, policy] of policies) {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname=$2 AND cmd='SELECT'",
      [table, policy],
    );
    assert.equal(rows[0].n, 1, `missing or non-SELECT policy ${policy}`);
  }

  for (const table of tables) {
    assert.equal(await hasTablePrivilege(client, "authenticated", table, "SELECT"), true, `authenticated must read ${table}`);
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      assert.equal(await hasTablePrivilege(client, "authenticated", table, privilege), false, `authenticated must not ${privilege} ${table}`);
    }
    assert.equal(await hasTablePrivilege(client, "service_role", table, "SELECT"), true, `service_role must read ${table}`);
    assert.equal(await hasTablePrivilege(client, "service_role", table, "INSERT"), true, `service_role must write ${table}`);
    assert.equal(await hasTablePrivilege(client, "anon", table, "SELECT"), false, `anon must not read ${table}`);
  }
}

// ---------------------------------------------------------------------------
// turns
// ---------------------------------------------------------------------------

async function turns(client) {
  const actor = await makeActor(client, "turns");
  const sessionId = await makeSession(client, actor);

  const first = (
    await client.query("SELECT public.begin_assistant_turn($1,$2,$3) AS id", [sessionId, actor.brandKey, actor.userId])
  ).rows[0].id;
  assert.ok(first);
  const live = await client.query("SELECT status, stop_reason FROM public.assistant_turns WHERE id=$1", [first]);
  assert.deepEqual(live.rows[0], { status: "streaming", stop_reason: null });

  await raises(client, () => client.query("SELECT public.begin_assistant_turn($1,$2,$3)", [sessionId, actor.brandKey, actor.userId]), /turn_in_progress/);

  await client.query("UPDATE public.assistant_turns SET heartbeat_at = now() - interval '2 minutes' WHERE id=$1", [first]);
  const second = (
    await client.query("SELECT public.begin_assistant_turn($1,$2,$3) AS id", [sessionId, actor.brandKey, actor.userId])
  ).rows[0].id;
  assert.notEqual(second, first);
  const stale = await client.query("SELECT status, stop_reason FROM public.assistant_turns WHERE id=$1", [first]);
  assert.deepEqual(stale.rows[0], { status: "interrupted", stop_reason: "interrupted" });
  const streaming = await client.query("SELECT count(*)::int AS n FROM public.assistant_turns WHERE session_id=$1 AND status='streaming'", [sessionId]);
  assert.equal(streaming.rows[0].n, 1);

  const archived = await makeSession(client, { ...actor, archivedAt: new Date().toISOString() });
  await raises(
    client,
    () => client.query("SELECT public.begin_assistant_turn($1,$2,$3)", [archived, actor.brandKey, actor.userId]),
    /session_not_found/,
  );
  const foreign = await makeActor(client, "turns-foreign");
  await raises(
    client,
    () => client.query("SELECT public.begin_assistant_turn($1,$2,$3)", [sessionId, actor.brandKey, foreign.userId]),
    /session_not_found/,
  );
}

// ---------------------------------------------------------------------------
// rewind
// ---------------------------------------------------------------------------

async function rewind(client) {
  const actor = await makeActor(client, "rewind");
  const sessionId = await makeSession(client, actor);
  const turnId = await makeTurn(client, { sessionId, ...actor, status: "completed" });
  const t0 = "2026-09-01T10:00:00Z";
  const t1 = "2026-09-01T10:01:00Z";
  const t2 = "2026-09-01T10:02:00Z";
  await makeMessage(client, { sessionId, ...actor, messageId: "m1", turnId, createdAt: t0 });
  await makeMessage(client, { sessionId, ...actor, messageId: "m2", role: "assistant", turnId, createdAt: t1 });
  await makeMessage(client, { sessionId, ...actor, messageId: "m3", turnId, createdAt: t2 });
  await client.query(
    `UPDATE public.assistant_sessions
        SET summary='earlier messages',
            compacted_through_seq=(SELECT seq FROM public.assistant_messages WHERE session_id=$1 AND id='m2')
      WHERE id=$1`,
    [sessionId],
  );
  const before = await makeApproval(client, { sessionId, ...actor, turnId, createdAt: "2026-09-01T10:00:30Z" });
  const after = await makeApproval(client, { sessionId, ...actor, turnId, createdAt: t1 });

  const removed = (
    await client.query("SELECT public.rewind_assistant_session($1,$2,'m2') AS removed", [sessionId, actor.userId])
  ).rows[0].removed;
  assert.equal(removed, 2);
  const remaining = await client.query("SELECT id FROM public.assistant_messages WHERE session_id=$1 ORDER BY seq", [sessionId]);
  assert.deepEqual(remaining.rows.map((r) => r.id), ["m1"]);
  const compacted = await client.query("SELECT summary, compacted_through_seq FROM public.assistant_sessions WHERE id=$1", [sessionId]);
  assert.deepEqual(compacted.rows[0], { summary: null, compacted_through_seq: null });
  const approvals = await client.query("SELECT id, status FROM public.assistant_approvals WHERE session_id=$1 ORDER BY created_at", [sessionId]);
  assert.deepEqual(
    approvals.rows,
    [
      { id: before, status: "pending" },
      { id: after, status: "expired" },
    ],
  );

  await raises(
    client,
    () => client.query("SELECT public.rewind_assistant_session($1,$2,'missing')", [sessionId, actor.userId]),
    /message_not_found/,
  );
  const foreign = await makeActor(client, "rewind-foreign");
  await raises(
    client,
    () => client.query("SELECT public.rewind_assistant_session($1,$2,'m1')", [sessionId, foreign.userId]),
    /session_not_found/,
  );
}

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

async function approvals(client) {
  const actor = await makeActor(client, "approvals");
  const sessionId = await makeSession(client, actor);
  const pending = await makeApproval(client, { sessionId, ...actor, kind: "price", quote: { totalUsd: 0.25 } });

  const claimed = (
    await client.query("SELECT * FROM public.claim_assistant_approval($1,$2,$3,$4)", [pending, actor.userId, actor.brandKey, 0.25])
  ).rows[0];
  assert.equal(claimed.status, "running");
  assert.equal(Number(claimed.approved_max_usd), 0.25);
  assert.ok(claimed.decided_at);
  await raises(
    client,
    () => client.query("SELECT * FROM public.claim_assistant_approval($1,$2,$3,$4)", [pending, actor.userId, actor.brandKey, 0.25]),
    /approval_not_pending/,
  );

  const expired = await makeApproval(client, {
    sessionId,
    ...actor,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await raises(
    client,
    () => client.query("SELECT * FROM public.claim_assistant_approval($1,$2,$3,$4)", [expired, actor.userId, actor.brandKey, 0.1]),
    /approval_expired/,
  );
  // SPEC GAP: the verbatim function sets status = 'expired' and then RAISEs in
  // the same invocation, so the UPDATE is rolled back with the error. The row
  // stays pending until expire_assistant_approvals marks it below.
  const expiredRow = await client.query("SELECT status FROM public.assistant_approvals WHERE id=$1", [expired]);
  assert.equal(expiredRow.rows[0].status, "pending");

  const foreign = await makeActor(client, "approvals-foreign");
  await raises(
    client,
    () => client.query("SELECT * FROM public.claim_assistant_approval($1,$2,$3,$4)", [pending, foreign.userId, actor.brandKey, 0.1]),
    /approval_not_found/,
  );

  const stalePending = await makeApproval(client, {
    sessionId,
    ...actor,
    expiresAt: new Date(Date.now() - 120_000).toISOString(),
  });
  const stuckRunning = await makeApproval(client, {
    sessionId,
    ...actor,
    status: "running",
    decidedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
  });
  const freshRunning = await makeApproval(client, {
    sessionId,
    ...actor,
    status: "running",
    decidedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const maintenance = (
    await client.query("SELECT public.expire_assistant_approvals(now(), 1000) AS result")
  ).rows[0].result;
  assert.ok(maintenance.expired >= 1, `expected at least one expired approval, got ${JSON.stringify(maintenance)}`);
  assert.ok(maintenance.failed >= 1, `expected at least one failed stuck approval, got ${JSON.stringify(maintenance)}`);
  const statuses = await client.query(
    "SELECT id, status, error_code FROM public.assistant_approvals WHERE id = ANY($1::uuid[]) ORDER BY id",
    [[stalePending, stuckRunning, freshRunning, expired]],
  );
  const byId = Object.fromEntries(statuses.rows.map((row) => [row.id, row]));
  assert.equal(byId[stalePending].status, "expired");
  assert.equal(byId[expired].status, "expired");
  assert.equal(byId[stuckRunning].status, "failed");
  assert.equal(byId[stuckRunning].error_code, "interrupted");
  assert.equal(byId[freshRunning].status, "running");
}

// ---------------------------------------------------------------------------
// chunks
// ---------------------------------------------------------------------------

async function chunks(client) {
  const actor = await makeActor(client, "chunks");
  const sessionId = await makeSession(client, actor);
  const oldTurn = await makeTurn(client, { sessionId, ...actor, status: "completed" });
  const recentTurn = await makeTurn(client, { sessionId, ...actor, status: "completed" });
  const liveTurn = await makeTurn(client, { sessionId, ...actor, status: "streaming" });
  await client.query("UPDATE public.assistant_turns SET finished_at = now() - interval '1 hour' WHERE id=$1", [oldTurn]);
  await client.query("UPDATE public.assistant_turns SET finished_at = now() WHERE id=$1", [recentTurn]);
  for (const [turnId, seq] of [[oldTurn, 0], [oldTurn, 1], [recentTurn, 0], [liveTurn, 0]]) {
    await client.query(
      "INSERT INTO public.assistant_stream_chunks(turn_id,seq,brand_key,data) VALUES($1,$2,$3,$4)",
      [turnId, seq, actor.brandKey, `data: {"type":"text-delta","id":"t","delta":"chunk ${seq}"}\n\n`],
    );
  }
  const pruned = (
    await client.query("SELECT public.prune_assistant_stream_chunks(now() - interval '10 minutes', 5000) AS n")
  ).rows[0].n;
  assert.equal(pruned, 2);
  const counts = await client.query(
    "SELECT turn_id, count(*)::int AS n FROM public.assistant_stream_chunks WHERE turn_id = ANY($1::uuid[]) GROUP BY turn_id ORDER BY turn_id",
    [[oldTurn, recentTurn, liveTurn]],
  );
  const remaining = Object.fromEntries(counts.rows.map((row) => [row.turn_id, row.n]));
  assert.equal(remaining[oldTurn], undefined);
  assert.equal(remaining[recentTurn], 1);
  assert.equal(remaining[liveTurn], 1);
}

// ---------------------------------------------------------------------------
// gsc
// ---------------------------------------------------------------------------

async function gsc(client) {
  const brandKey = `qa-f22-gsc-${id()}.example`;
  const url = `https://${brandKey}`;
  await client.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host) VALUES($1,$1,$2,$1)",
    [brandKey, url],
  );
  await client.query(
    "INSERT INTO public.gsc_connections(brand,brand_key,site_url,enabled,connection_generation,last_ingested_through) VALUES($1,$1,$2,true,1,'2026-11-02')",
    [brandKey, `sc-domain:${brandKey}`],
  );
  const add = (date, query, clicks, impressions, position, generation = 1) =>
    client.query(
      `INSERT INTO public.gsc_daily(brand,date,query,site_url,clicks,impressions,ctr,position,brand_key,connection_generation)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$1,$9)`,
      [brandKey, date, query, url, clicks, impressions, impressions ? clicks / impressions : 0, position, generation],
    );
  await add("2026-11-01", "acme tees", 5, 100, 2);
  await add("2026-11-02", "acme tees", 1, 100, 4);
  await add("2026-11-01", "rival shirts", 2, 50, 8);
  // A replaced Search Console property: its rows must never be mixed in.
  await add("2026-11-01", "acme tees", 99, 999, 1, 2);

  const all = await client.query(
    "SELECT * FROM public.assistant_gsc_query_summary($1,'2026-10-01')",
    [brandKey],
  );
  assert.deepEqual(all.rows, [
    { query: "acme tees", clicks: "6", impressions: "200", ctr: "0.0300", avg_position: "3.0" },
    { query: "rival shirts", clicks: "2", impressions: "50", ctr: "0.0400", avg_position: "8.0" },
  ]);

  const filtered = await client.query(
    "SELECT query FROM public.assistant_gsc_query_summary($1,'2026-10-01',2,9,100,NULL,100)",
    [brandKey],
  );
  assert.deepEqual(filtered.rows, [{ query: "acme tees" }]);
  const byText = await client.query(
    "SELECT query FROM public.assistant_gsc_query_summary($1,'2026-10-01',NULL,NULL,0,'ACME',100)",
    [brandKey],
  );
  assert.deepEqual(byText.rows, [{ query: "acme tees" }]);
  const since = await client.query(
    "SELECT clicks FROM public.assistant_gsc_query_summary($1,'2026-11-02',NULL,NULL,0,NULL,100)",
    [brandKey],
  );
  assert.deepEqual(since.rows, [{ clicks: "1" }]);
  // An unknown workspace reads nothing.
  const other = await client.query(
    "SELECT count(*)::int AS n FROM public.assistant_gsc_query_summary($1,'2026-10-01')",
    [`qa-f22-unknown-${id()}.example`],
  );
  assert.equal(other.rows[0].n, 0);

  await client.query(
    `INSERT INTO public.gsc_daily(brand,date,query,site_url,clicks,impressions,ctr,position,brand_key,connection_generation)
     SELECT $1,'2026-11-01','bulk query '||g,$2,1,10,0.1,5,$1,1 FROM generate_series(1,505) g`,
    [brandKey, url],
  );
  const capped = await client.query(
    "SELECT count(*)::int AS n FROM public.assistant_gsc_query_summary($1,'2026-10-01',NULL,NULL,0,NULL,1000)",
    [brandKey],
  );
  assert.equal(capped.rows[0].n, 500);
  const floor = await client.query(
    "SELECT count(*)::int AS n FROM public.assistant_gsc_query_summary($1,'2026-10-01',NULL,NULL,0,NULL,0)",
    [brandKey],
  );
  assert.equal(floor.rows[0].n, 1);
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

async function retention(client) {
  const actor = await makeActor(client, "retention");
  const oldUpdated = new Date(Date.now() - 396 * 86_400_000).toISOString();
  const old = await makeSession(client, { ...actor, updatedAt: oldUpdated });
  const oldTurn = await makeTurn(client, { sessionId: old, ...actor, status: "completed" });
  await makeMessage(client, { sessionId: old, ...actor, messageId: "old-message", turnId: oldTurn });
  await makeApproval(client, { sessionId: old, ...actor, turnId: oldTurn });
  await client.query(
    "INSERT INTO public.assistant_stream_chunks(turn_id,seq,brand_key,data) VALUES($1,0,$2,'data: [DONE]\n\n')",
    [oldTurn, actor.brandKey],
  );

  const recent = await makeSession(client, actor);
  const recentTurn = await makeTurn(client, { sessionId: recent, ...actor, status: "completed" });
  await makeMessage(client, { sessionId: recent, ...actor, messageId: "recent-message", turnId: recentTurn });

  const cutoff = new Date(Date.now() - 395 * 86_400_000).toISOString();
  const pruned = (await client.query("SELECT public.prune_assistant_sessions($1,500) AS n", [cutoff])).rows[0].n;
  assert.equal(pruned, 1);
  for (const table of ["assistant_sessions", "assistant_messages", "assistant_turns", "assistant_approvals"]) {
    const column = table === "assistant_sessions" ? "id" : table === "assistant_messages" || table === "assistant_approvals" ? "session_id" : "session_id";
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${column}=$1`, [old]);
    assert.equal(rows[0].n, 0, `${table} rows for the pruned session must cascade`);
  }
  const chunks = await client.query("SELECT count(*)::int AS n FROM public.assistant_stream_chunks WHERE turn_id=$1", [oldTurn]);
  assert.equal(chunks.rows[0].n, 0);
  const survives = await client.query("SELECT count(*)::int AS n FROM public.assistant_sessions WHERE id=$1", [recent]);
  assert.equal(survives.rows[0].n, 1);

  const batch = [];
  for (let i = 0; i < 3; i += 1) batch.push(await makeSession(client, { ...actor, updatedAt: oldUpdated }));
  const limited = (await client.query("SELECT public.prune_assistant_sessions($1,2) AS n", [cutoff])).rows[0].n;
  assert.equal(limited, 2);
  const left = await client.query("SELECT count(*)::int AS n FROM public.assistant_sessions WHERE id = ANY($1::uuid[])", [batch]);
  assert.equal(left.rows[0].n, 1);
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
  for (const [label, actor] of [["a1", workspaceA], ["a2", a2], ["b1", workspaceB]]) {
    const sessionId = await makeSession(client, actor);
    const turnId = await makeTurn(client, { sessionId, ...actor, status: "completed" });
    await makeMessage(client, { sessionId, ...actor, messageId: `msg-${label}`, turnId });
    const approvalId = await makeApproval(client, { sessionId, ...actor, turnId });
    seeded[label] = { sessionId, turnId, approvalId, userId: actor.userId };
  }

  const a1Counts = await rlsCounts(client, seeded.a1.userId);
  assert.equal(a1Counts.assistant_sessions.n, 1);
  assert.deepEqual(a1Counts.assistant_sessions.ids, [seeded.a1.sessionId]);
  assert.equal(a1Counts.assistant_messages.n, 1);
  assert.deepEqual(a1Counts.assistant_turns.ids, [seeded.a1.turnId]);
  assert.deepEqual(a1Counts.assistant_approvals.ids, [seeded.a1.approvalId]);

  const a2Counts = await rlsCounts(client, a2.userId);
  assert.equal(a2Counts.assistant_sessions.n, 1);
  assert.deepEqual(a2Counts.assistant_sessions.ids, [seeded.a2.sessionId]);
  assert.equal(a2Counts.assistant_sessions.ids.includes(seeded.a1.sessionId), false, "A2 must not read A1's session");
  assert.deepEqual(a2Counts.assistant_messages.ids, ["msg-a2"]);
  assert.deepEqual(a2Counts.assistant_turns.ids, [seeded.a2.turnId]);
  assert.deepEqual(a2Counts.assistant_approvals.ids, [seeded.a2.approvalId]);

  const b1Counts = await rlsCounts(client, seeded.b1.userId);
  assert.equal(b1Counts.assistant_sessions.n, 1);
  assert.deepEqual(b1Counts.assistant_sessions.ids, [seeded.b1.sessionId]);
  assert.equal(b1Counts.assistant_sessions.ids.includes(seeded.a1.sessionId), false);
  assert.deepEqual(b1Counts.assistant_messages.ids, ["msg-b1"]);
  assert.deepEqual(b1Counts.assistant_turns.ids, [seeded.b1.turnId]);
  assert.deepEqual(b1Counts.assistant_approvals.ids, [seeded.b1.approvalId]);

  await client.query("RESET ROLE");
  await client.query("SET LOCAL ROLE anon");
  for (const table of ["assistant_sessions", "assistant_messages", "assistant_turns", "assistant_stream_chunks", "assistant_approvals"]) {
    await raises(client, () => client.query(`SELECT count(*) FROM public.${table}`), /permission denied/);
  }
  await client.query("RESET ROLE");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const GROUPS = {
  schema,
  turns,
  rewind,
  approvals,
  chunks,
  gsc,
  retention,
  rls,
};

try {
  if (targetGroup && !GROUPS[targetGroup]) {
    throw new Error(`unknown group "${targetGroup}"; known groups: ${Object.keys(GROUPS).join(", ")}`);
  }
  if (FRESH) {
    await freshDatabase();
  } else if (!targetGroup || targetGroup === "schema") {
    const { rows } = await pool.query("SELECT to_regclass('public.assistant_sessions') IS NOT NULL AS ok");
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
