#!/usr/bin/env node
// F12 Phase 1 database contract: links every collected answer of a workspace
// to a stable workspace_questions id. Only a disposable loopback QA/UAT
// database is accepted. Never production: loopback host, _qa/_uat database
// name, no DATABASE_URL. Connection settings come from the PG* env vars.
//
// Usage:
//   PGHOST=127.0.0.1 PGPORT=55440 PGDATABASE=aeovis_f12_qa node scripts/qa/check-f12-db.mjs
//   ... check-f12-db.mjs --group link-scan
//   ... check-f12-db.mjs --fresh   (rebuild schemas, apply every migration in
//                                  lexical order as CI does, then run all groups)
//
// Groups: links-rls (AC-01), link-scan (AC-02), link-explore-legacy (AC-03),
// link-import (AC-04), links-retention (AC-12).
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
) {
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const MIGRATION_095 = "095_f12_question_answer_links.sql";
const FRESH = process.argv.includes("--fresh");
const pool = new pg.Pool({ max: 4 });
const passed = [];
const groupFlagIdx = process.argv.indexOf("--group");
const targetGroup = groupFlagIdx !== -1 ? process.argv[groupFlagIdx + 1] : null;
const id = () => randomUUID();
const Q1_TEXT = "Best oversized tees in India";
const Q2_TEXT = "How do teams compare invoice providers?";

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");

async function group(name, fn) {
  if (targetGroup && targetGroup !== name) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("ROLLBACK");
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* keep the test failure */ }
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
  assert.ok(files.includes(MIGRATION_095), "migration 095 must be on disk");
  for (const file of files) {
    try {
      await pool.query(readFileSync(path.join(MIGRATIONS, file), "utf8"));
    } catch (error) {
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
  }
  console.log(`fresh: applied ${files.length} migrations in lexical order`);
}

async function makeBrand(client, suffix) {
  const brandKey = `qa-f12-${suffix}-${id()}.example`;
  await client.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host) VALUES($1,$2,$3,$4)",
    [brandKey, `F12 QA ${suffix}`, `https://${brandKey}`, brandKey],
  );
  return brandKey;
}

async function makeUser(client, suffix) {
  const userId = id();
  await client.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
    [userId, `${userId}@${suffix}.f12.test`],
  );
  return userId;
}

async function makeQuestion(client, brandKey, text) {
  const { rows } = await client.query(
    "INSERT INTO public.workspace_questions(brand_key,text,origin) VALUES($1,$2,'manual') RETURNING id",
    [brandKey, text],
  );
  return rows[0].id;
}

async function makeScanJob(client, brandKey, prompts) {
  const jobId = id();
  // Terminal status: only one running-status job may exist per workspace
  // (scan_jobs_one_running_per_workspace), and linking reads finished scans.
  await client.query(
    "INSERT INTO public.scan_jobs(id,brand,brand_key,status,checkpoint,panel_snapshot) VALUES($1,$2,$2,'complete',$3,$4)",
    [jobId, brandKey, JSON.stringify({ prompt_key: `qa-f12-${jobId}` }),
      JSON.stringify({ payload: { prompts } })],
  );
  return jobId;
}

async function makeObservation(client, { jobId = null, brandKey = null, purpose = "scan", engine = "chatgpt", query, state = "answered", exploreRunId = null }) {
  const obsId = `f12-${id()}`;
  const context = exploreRunId ? { explore_run_id: exploreRunId } : {};
  await client.query(
    `INSERT INTO public.probe_observations
       (id,job_id,purpose,engine,query,context,config_version,circuit_key,state,deadline_at,brand_key)
     VALUES($1,$2,$3,$4,$5,$6,'f12-qa-v1',$7,$8,now()+interval '1 hour',$9)`,
    [obsId, jobId, purpose, engine, query, JSON.stringify(context), `f12-ck-${id()}`, state, brandKey],
  );
  return obsId;
}

async function makePromptResult(client, { jobId, brandKey, query, engine = "chatgpt" }) {
  const { rows } = await client.query(
    "INSERT INTO public.prompt_results(job_id,brand,query,engine,answered) VALUES($1,$2,$3,$4,true) RETURNING id",
    [jobId, brandKey, query, engine],
  );
  return rows[0].id;
}

async function link(client, brandKey, { limit = 2000, importMissing = false, linkedBy = "periodic" } = {}) {
  const { rows } = await client.query(
    "SELECT public.link_question_answers($1,$2,$3,$4) AS result",
    [brandKey, limit, importMissing, linkedBy],
  );
  return rows[0].result;
}

function hasF11Explore(client) {
  return client.query(
    "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'probe_observations_explore_shape'",
  ).then(({ rows }) => rows[0].n > 0);
}

if (FRESH) {
  await freshDatabase();
} else {
  // The migration is idempotent: a default run proves 095 applies on a
  // loopback database that already holds the earlier migrations (the F08
  // guard passes because 075–076 precede 095 in filename order).
  await pool.query(read("supabase/migrations", MIGRATION_095));
}

await group("links-rls", async (client) => {
  const userA = await makeUser(client, "rls");
  const userB = await makeUser(client, "rls");
  const brandA = await makeBrand(client, "rls-a");
  const brandB = await makeBrand(client, "rls-b");
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
    [userA, brandA, userB, brandB],
  );
  const questionA = await makeQuestion(client, brandA, Q1_TEXT);
  const questionB = await makeQuestion(client, brandB, Q1_TEXT);
  const jobA = id();
  const jobB = id();
  const legacyA = await makePromptResult(client, { jobId: jobA, brandKey: brandA, query: Q1_TEXT });
  const legacyB = await makePromptResult(client, { jobId: jobB, brandKey: brandB, query: Q1_TEXT });
  await client.query(
    `INSERT INTO public.question_answer_links(brand_key,question_id,source,prompt_result_id,scan_job_id,engine,asked_text,collected_at,linked_by)
     VALUES($1,$2,'legacy',$3,$4,'chatgpt',$5,now(),'backfill'),($6,$7,'legacy',$8,$9,'chatgpt',$10,now(),'backfill')`,
    [brandA, questionA, legacyA, jobA, Q1_TEXT, brandB, questionB, legacyB, jobB, Q1_TEXT],
  );

  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userA]);
  {
    const { rows } = await client.query("SELECT brand_key FROM public.question_answer_links");
    assert.deepEqual(rows.map((row) => row.brand_key), [brandA], "tenant A must read only A's links");
  }
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userB]);
  {
    const { rows } = await client.query("SELECT brand_key FROM public.question_answer_links");
    assert.deepEqual(rows.map((row) => row.brand_key), [brandB], "tenant B must read only B's links");
  }
  await client.query("RESET ROLE");
  await client.query("SET LOCAL ROLE anon");
  await client.query("SAVEPOINT f12_anon_read");
  await assert.rejects(
    client.query("SELECT count(*) FROM public.question_answer_links"),
    (error) => error.code === "42501",
    "anon must be refused links",
  );
  await client.query("ROLLBACK TO SAVEPOINT f12_anon_read");
  await client.query("RESET ROLE");
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userA]);
  await client.query("SAVEPOINT f12_customer_write");
  await assert.rejects(
    client.query(
      "INSERT INTO public.question_answer_links(brand_key,question_id,source,prompt_result_id,engine,asked_text,collected_at,linked_by) VALUES($1,$2,'legacy',$3,'chatgpt',$4,now(),'backfill')",
      [brandA, questionA, legacyA, Q1_TEXT],
    ),
    (error) => error.code === "42501",
    "customers must not write links directly",
  );
  await client.query("ROLLBACK TO SAVEPOINT f12_customer_write");
});

await group("link-scan", async (client) => {
  const brandA = await makeBrand(client, "scan-a");
  const brandB = await makeBrand(client, "scan-b");
  const q1 = await makeQuestion(client, brandA, Q1_TEXT);
  await makeQuestion(client, brandA, Q2_TEXT);
  await makeQuestion(client, brandB, Q1_TEXT);

  // Scan 1: panel v1 carries no question ids, so links resolve by normalized text.
  const job1 = await makeScanJob(client, brandA, [
    { id: "v1-prompt-1", question_id: null, text: Q1_TEXT },
  ]);
  // Scan 2: panel v2 freezes question_id = Q1 for the same text with odd spacing.
  const job2 = await makeScanJob(client, brandA, [
    { id: `q-${q1}`, question_id: q1, text: "best  oversized tees in india" },
  ]);
  const oddText = "best  oversized tees in india";

  const answered1 = await makeObservation(client, { jobId: job1, query: Q1_TEXT, state: "answered" });
  const validNoAio = await makeObservation(client, { jobId: job1, query: Q1_TEXT, engine: "aio", state: "valid_no_aio" });
  const failed1 = await makeObservation(client, { jobId: job1, query: Q1_TEXT, engine: "perplexity", state: "failed" });
  const leased = await makeObservation(client, { jobId: job1, query: Q1_TEXT, engine: "gemini", state: "leased" });
  const posted = await makeObservation(client, { jobId: job1, query: Q1_TEXT, engine: "grok", state: "posted" });
  const unmatchedObs = await makeObservation(client, { jobId: job1, query: "What is the capital of Peru?", state: "answered" });
  const answered2 = await makeObservation(client, { jobId: job2, query: oddText, state: "answered" });
  // Same text in workspace B must never link to A's question.
  const jobB = await makeScanJob(client, brandB, [{ id: "v1-b", question_id: null, text: Q1_TEXT }]);
  const brandBObs = await makeObservation(client, { jobId: jobB, query: Q1_TEXT, state: "answered" });

  const pr1 = await makePromptResult(client, { jobId: job1, brandKey: brandA, query: Q1_TEXT });
  await makePromptResult(client, { jobId: job1, brandKey: brandA, query: Q1_TEXT, engine: "aio" });
  await makePromptResult(client, { jobId: job1, brandKey: brandA, query: Q1_TEXT, engine: "perplexity" });
  const pr2 = await makePromptResult(client, { jobId: job2, brandKey: brandA, query: oddText });

  const first = await link(client, brandA);
  assert.equal(first.scan, 4, "four terminal scan observations link (answered, valid_no_aio, failed, scan-2 answered)");
  assert.equal(first.explore, 0);
  assert.equal(first.legacy, 0);
  assert.equal(first.imported, 0);
  assert.equal(first.unmatched, 1, "the Peru question has no workspace question yet");

  const { rows: linked } = await client.query(
    "SELECT observation_id, question_id, prompt_result_id, scan_job_id FROM public.question_answer_links WHERE brand_key=$1 ORDER BY observation_id",
    [brandA],
  );
  assert.equal(linked.length, 4);
  for (const row of linked) {
    assert.equal(row.question_id, q1, "both scans link to Q1");
    assert.ok(row.prompt_result_id, "prompt_result_id is filled from the matching prompt_results row");
    assert.ok([job1, job2].includes(row.scan_job_id), "scan_job_id is filled");
  }
  assert.deepEqual(
    linked.map((row) => row.observation_id).sort(),
    [answered1, validNoAio, failed1, answered2].sort(),
  );
  const prOfAnswered1 = await client.query(
    "SELECT prompt_result_id FROM public.question_answer_links WHERE observation_id=$1",
    [answered1],
  );
  assert.equal(prOfAnswered1.rows[0].prompt_result_id, pr1);
  const prOfAnswered2 = await client.query(
    "SELECT prompt_result_id FROM public.question_answer_links WHERE observation_id=$1",
    [answered2],
  );
  assert.equal(prOfAnswered2.rows[0].prompt_result_id, pr2);

  for (const skipped of [leased, posted, unmatchedObs, brandBObs]) {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM public.question_answer_links WHERE observation_id=$1",
      [skipped],
    );
    assert.equal(rows[0].n, 0, `non-terminal, unmatched or foreign observation ${skipped} must stay unlinked`);
  }

  const second = await link(client, brandA);
  assert.deepEqual(second, { scan: 0, explore: 0, legacy: 0, imported: 0, unmatched: 1 }, "repeat run inserts nothing");
});

await group("link-explore-legacy", async (client) => {
  const explore = await hasF11Explore(client);
  const brandA = await makeBrand(client, "explore-a");
  const brandB = await makeBrand(client, "explore-b");
  const q1 = await makeQuestion(client, brandA, Q1_TEXT);
  await makeQuestion(client, brandB, Q1_TEXT);

  const legacyJob1 = await makeScanJob(client, brandA, []);
  const legacyJob2 = await makeScanJob(client, brandA, []);
  const legacy1 = await makePromptResult(client, { jobId: legacyJob1, brandKey: brandA, query: Q1_TEXT });
  const legacy2 = await makePromptResult(client, { jobId: legacyJob2, brandKey: brandA, query: Q1_TEXT, engine: "aio" });
  // A prompt_results row with a live observation is not legacy: it must not link twice.
  const liveJob = await makeScanJob(client, brandA, [{ id: "live", question_id: null, text: Q1_TEXT }]);
  await makePromptResult(client, { jobId: liveJob, brandKey: brandA, query: Q1_TEXT, engine: "perplexity" });
  const liveObs = await makeObservation(client, { jobId: liveJob, query: Q1_TEXT, engine: "perplexity", state: "answered" });

  let exploreA = [];
  let exploreB = null;
  if (explore) {
    const runA = id();
    exploreA = [
      await makeObservation(client, { brandKey: brandA, purpose: "explore", query: Q1_TEXT, state: "answered", exploreRunId: runA }),
      await makeObservation(client, { brandKey: brandA, purpose: "explore", query: Q1_TEXT, engine: "aio", state: "failed", exploreRunId: runA }),
    ];
    // Workspace B's explore answers never link to A's question.
    exploreB = await makeObservation(client, { brandKey: brandB, purpose: "explore", query: Q1_TEXT, state: "answered", exploreRunId: id() });
  }

  const first = await link(client, brandA);
  assert.equal(first.legacy, 2, "both legacy prompt_results rows link");
  if (explore) {
    assert.equal(first.explore, 2, "both explore observations of this workspace link");
  } else {
    assert.equal(first.explore, 0, "no explore rows exist before F11's 090");
  }

  const { rows: legacyLinks } = await client.query(
    "SELECT prompt_result_id, scan_job_id, explore_run_id, observation_id FROM public.question_answer_links WHERE brand_key=$1 AND source='legacy' ORDER BY prompt_result_id",
    [brandA],
  );
  assert.deepEqual(legacyLinks.map((row) => row.prompt_result_id).sort(), [legacy1, legacy2].sort());
  for (const row of legacyLinks) {
    assert.ok(row.scan_job_id, "legacy links keep their scan_job_id");
    assert.equal(row.explore_run_id, null);
    assert.equal(row.observation_id, null);
  }

  if (explore) {
    const { rows: exploreLinks } = await client.query(
      "SELECT observation_id, question_id, explore_run_id FROM public.question_answer_links WHERE brand_key=$1 AND source='explore'",
      [brandA],
    );
    assert.deepEqual(exploreLinks.map((row) => row.observation_id).sort(), exploreA.sort());
    for (const row of exploreLinks) {
      assert.equal(row.question_id, q1);
      assert.ok(row.explore_run_id, "explore links keep their explore_run_id");
    }
    const { rows: leaked } = await client.query(
      "SELECT count(*)::int AS n FROM public.question_answer_links WHERE observation_id=$1",
      [exploreB],
    );
    assert.equal(leaked[0].n, 0, "workspace B explore answers never link to A's question");
    const brandBResult = await link(client, brandB);
    assert.equal(brandBResult.explore, 1, "B's explore answer links to B's own question");
  } else {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM public.question_answer_links WHERE source='explore'");
    assert.equal(rows[0].n, 0, "no explore links may exist before F11's 090");
  }

  const { rows: liveLinks } = await client.query(
    "SELECT count(*)::int AS n FROM public.question_answer_links WHERE observation_id=$1 AND source='legacy'",
    [liveObs],
  );
  assert.equal(liveLinks[0].n, 0, "an observation-backed row is never linked as legacy");
  const second = await link(client, brandA);
  assert.equal(second.scan + second.explore + second.legacy, 0, "repeat run links nothing new");
});

await group("link-import", async (client) => {
  const brandA = await makeBrand(client, "import-a");
  const q1 = await makeQuestion(client, brandA, Q1_TEXT);
  const historicalText = "Do major retailers stock plus-size festive kurtas?";
  const historicalJob = await makeScanJob(client, brandA, []);
  await makePromptResult(client, { jobId: historicalJob, brandKey: brandA, query: historicalText });

  const before = await link(client, brandA);
  assert.equal(before.legacy, 0, "history without a question stays unlinked");
  assert.equal(before.imported, 0, "nothing is imported unless asked");

  const imported = await link(client, brandA, { importMissing: true, linkedBy: "backfill" });
  assert.equal(imported.imported, 1, "one archived question is created for the historical text");
  assert.equal(imported.legacy, 1, "the historical row links once its question exists");

  const { rows: created } = await client.query(
    "SELECT id, topic, origin, status, branded FROM public.workspace_questions WHERE brand_key=$1 AND text_normalized=public.normalize_question_text($2)",
    [brandA, historicalText],
  );
  assert.equal(created.length, 1);
  assert.deepEqual(
    { topic: created[0].topic, origin: created[0].origin, status: created[0].status, branded: created[0].branded },
    { topic: "General", origin: "import", status: "archived", branded: false },
  );
  const { rows: historicalLinks } = await client.query(
    "SELECT question_id, linked_by FROM public.question_answer_links WHERE brand_key=$1 AND question_id=$2",
    [brandA, created[0].id],
  );
  assert.equal(historicalLinks.length, 1);
  assert.equal(historicalLinks[0].linked_by, "backfill");
  assert.notEqual(created[0].id, q1, "the import creates a new question, never reuses Q1");

  const repeat = await link(client, brandA, { importMissing: true, linkedBy: "backfill" });
  assert.deepEqual(repeat, { scan: 0, explore: 0, legacy: 0, imported: 0, unmatched: 0 }, "repeat imports create nothing");
});

await group("links-retention", async (client) => {
  const brandA = await makeBrand(client, "retention-a");
  const q1 = await makeQuestion(client, brandA, Q1_TEXT);
  const jobA = await makeScanJob(client, brandA, []);
  const oldResult = await makePromptResult(client, { jobId: jobA, brandKey: brandA, query: Q1_TEXT });
  const newResult = await makePromptResult(client, { jobId: jobA, brandKey: brandA, query: Q1_TEXT, engine: "aio" });
  await client.query(
    `INSERT INTO public.question_answer_links(brand_key,question_id,source,prompt_result_id,scan_job_id,engine,asked_text,collected_at,linked_by)
     VALUES($1,$2,'legacy',$3,$4,'chatgpt',$5,now()-interval '400 days','periodic'),
           ($1,$2,'legacy',$6,$4,'aio',$5,now()-interval '10 days','periodic')`,
    [brandA, q1, oldResult, jobA, Q1_TEXT, newResult],
  );
  const before = await client.query(
    "SELECT (SELECT count(*)::int FROM public.question_answer_links WHERE brand_key=$1) AS links, (SELECT count(*)::int FROM public.prompt_results WHERE brand=$1) AS results",
    [brandA],
  );
  assert.equal(before.rows[0].links, 2);

  const { rows: prunedRows } = await client.query(
    "SELECT public.prune_question_answer_links(now()-interval '395 days',5000) AS pruned",
  );
  assert.equal(prunedRows[0].pruned, 1, "only the link older than 395 days is pruned");

  const { rows: after } = await client.query(
    "SELECT prompt_result_id FROM public.question_answer_links WHERE brand_key=$1",
    [brandA],
  );
  assert.deepEqual(after.map((row) => row.prompt_result_id), [newResult], "the recent link survives");
  const counts = await client.query(
    "SELECT (SELECT count(*)::int FROM public.prompt_results WHERE brand=$1) AS results",
    [brandA],
  );
  assert.equal(counts.rows[0].results, before.rows[0].results, "retention never touches prompt_results");
});

await pool.end();
if (targetGroup) {
  console.log(`ok 1 group (${targetGroup})`);
} else {
  console.log(`ok ${passed.length} groups: ${passed.join(", ")}`);
}
