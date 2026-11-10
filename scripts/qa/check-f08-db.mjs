#!/usr/bin/env node
// F08 database contract: only a loopback QA/UAT database is accepted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { artifactHash, canonicalJson } from "../../src/lib/repairs/workflow.js";
import { normalizeQuestionText } from "../../src/lib/questions/workspaceQuestions.ts";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
) {
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
}

const pool = new pg.Pool({ max: 4 });
const passed = [];
const groupFlagIdx = process.argv.indexOf("--group");
const targetGroup = groupFlagIdx !== -1 ? process.argv[groupFlagIdx + 1] : null;
const fixtures = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/f08/normalize-cases.json", import.meta.url), "utf8"),
);
const id = () => randomUUID();

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

async function makeBrand(client, suffix) {
  const brandKey = `qa-f08-${suffix}-${id()}.example`;
  await client.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host,aliases) VALUES($1,$2,$3,$4,$5)",
    [brandKey, `F08 ${suffix}`, `https://${brandKey}`, brandKey, []],
  );
  return brandKey;
}

async function makeUser(client, suffix) {
  const userId = id();
  await client.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
    [userId, `${userId}@${suffix}.f08.test`],
  );
  return userId;
}

async function addQuestion(client, brandKey, {
  text,
  origin = "manual",
  status = "active",
  topic = "General",
  actor = null,
} = {}) {
  const { rows } = await client.query(
    "SELECT public.add_workspace_question($1,$2,$3,$4,$5,false,NULL,$6) AS result",
    [brandKey, text, topic, origin, status, actor],
  );
  return rows[0].result;
}

async function expectError(client, savepoint, query, values, matcher) {
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught;
  try {
    await client.query(query, values);
  } catch (error) {
    caught = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  assert.ok(caught, "operation unexpectedly succeeded");
  if (matcher instanceof RegExp) assert.match(caught.message, matcher);
  else assert.equal(caught.code, matcher);
  return caught;
}

async function appendPanel(client, brandKey, { prompts, persona = "QA buyers", context = { country: "in", language: "en" }, version = 0, state = "draft", actor = null }) {
  const payload = { persona, context, prompts };
  const { rows } = await client.query(
    "SELECT public.append_repair_artifact($1,'panel','default',$2,$3,$4::jsonb,$5,$6) AS artifact",
    [brandKey, version, state, JSON.stringify(payload), artifactHash(payload), actor],
  );
  return rows[0].artifact;
}

async function appendApprovedPanel(client, brandKey, { payload, expectedVersion, actor }) {
  const { rows } = await client.query(
    "SELECT public.append_approved_panel_with_questions($1,'default',$2,$3,$4) AS artifact",
    [brandKey, expectedVersion, canonicalJson(payload), actor],
  );
  return rows[0].artifact;
}

async function saveQuestion(client, brandKey, expectedRevision, rows) {
  return client.query(
    "SELECT public.save_workspace_questions($1,$2,$3::jsonb,'[]'::jsonb,NULL,NULL) AS result",
    [brandKey, expectedRevision, JSON.stringify(rows)],
  );
}

await group("normalize", async (client) => {
  for (const item of fixtures) {
    assert.equal(normalizeQuestionText(item.raw), item.normalized, item.name);
    const { rows } = await client.query(
      "SELECT public.normalize_question_text($1) AS normalized",
      [item.canonical],
    );
    assert.equal(rows[0].normalized, item.normalized, item.name);
  }
});

await group("schema", async (client) => {
  const { rows: atomicFunction } = await client.query(
    "SELECT to_regprocedure('public.append_approved_panel_with_questions(text,text,integer,text,uuid)') AS function",
  );
  assert.ok(atomicFunction[0].function, "atomic approved legacy panel RPC must exist");
  const brandKey = await makeBrand(client, "schema");
  const inserted = await client.query(
    "INSERT INTO public.workspace_questions(brand_key,text,origin) VALUES($1,$2,'manual') RETURNING id",
    [brandKey, "Which accounting tools are useful?"],
  );
  await expectError(
    client,
    "f08_text_immutable",
    "UPDATE public.workspace_questions SET text='Which other accounting tools are useful?' WHERE id=$1",
    [inserted.rows[0].id],
    /question_text_immutable/,
  );
  await expectError(
    client,
    "f08_unique_question",
    "INSERT INTO public.workspace_questions(brand_key,text,origin) VALUES($1,$2,'manual')",
    [brandKey, "WHICH ACCOUNTING TOOLS ARE USEFUL?"],
    "23505",
  );
  for (const [name, sql, values] of [
    ["origin", "INSERT INTO public.workspace_questions(brand_key,text,origin) VALUES($1,'Unsupported origin question?','bad')", [brandKey]],
    ["status", "INSERT INTO public.workspace_questions(brand_key,text,origin,status) VALUES($1,'Unsupported status question?','manual','bad')", [brandKey]],
    ["cohort", "INSERT INTO public.workspace_questions(brand_key,text,origin,cohort) VALUES($1,'Unsupported cohort question?','manual','rolling')", [brandKey]],
  ]) {
    await expectError(client, `f08_vocab_${name}`, sql, values, "23514");
  }
  const { rows } = await client.query(
    "SELECT c.relrowsecurity FROM pg_class c WHERE c.oid='public.workspace_questions'::regclass",
  );
  assert.equal(rows[0].relrowsecurity, true, "workspace_questions must have RLS enabled");
});

await group("rls", async (client) => {
  const userA = await makeUser(client, "rls");
  const userB = await makeUser(client, "rls");
  const brandA = await makeBrand(client, "rls-a");
  const brandB = await makeBrand(client, "rls-b");
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
    [userA, brandA, userB, brandB],
  );
  const questionA = id();
  const questionB = id();
  for (const [brandKey, userId, questionId, label] of [[brandA, userA, questionA, "A"], [brandB, userB, questionB, "B"]]) {
    await client.query(
      "INSERT INTO public.workspace_question_settings(brand_key,persona) VALUES($1,$2)",
      [brandKey, `Workspace ${label}`],
    );
    await client.query(
      "INSERT INTO public.workspace_questions(id,brand_key,text,origin) VALUES($1,$2,$3,'manual')",
      [questionId, brandKey, `Which tools serve workspace ${label}?`],
    );
    await client.query(
      "INSERT INTO public.workspace_question_events(brand_key,question_id,event,revision,actor) VALUES($1,$2,'created',1,$3)",
      [brandKey, questionId, userId],
    );
  }

  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userA]);
  for (const table of ["workspace_question_settings", "workspace_questions", "workspace_question_events"]) {
    const { rows } = await client.query(`SELECT brand_key FROM public.${table}`);
    assert.deepEqual(rows.map((row) => row.brand_key), [brandA], `${table} leaked or hid tenant A rows`);
  }
  await expectError(
    client,
    "f08_customer_write",
    "INSERT INTO public.workspace_questions(brand_key,text,origin) VALUES($1,'Customer direct write question?','manual')",
    [brandA],
    "42501",
  );

  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userB]);
  for (const table of ["workspace_question_settings", "workspace_questions", "workspace_question_events"]) {
    const { rows } = await client.query(`SELECT brand_key FROM public.${table}`);
    assert.deepEqual(rows.map((row) => row.brand_key), [brandB], `${table} leaked or hid tenant B rows`);
  }
  const leaked = await client.query(
    "SELECT count(*)::int AS n FROM public.workspace_questions WHERE brand_key=$1",
    [brandA],
  );
  assert.equal(leaked.rows[0].n, 0, "tenant B must see zero of tenant A's questions");
});

await group("add", async (client) => {
  const brandKey = await makeBrand(client, "add");
  await client.query("SET LOCAL ROLE service_role");
  const created = await addQuestion(client, brandKey, { text: "Which tools help small teams?" });
  const existing = await addQuestion(client, brandKey, { text: "WHICH TOOLS HELP SMALL TEAMS?" });
  assert.equal(created.created, true);
  assert.equal(existing.created, false);
  assert.equal(existing.id, created.id);

  const archived = await addQuestion(client, brandKey, {
    text: "How can archived imports preserve history?",
    origin: "import",
    status: "archived",
  });
  assert.equal(archived.created, true);
  const revived = await addQuestion(client, brandKey, {
    text: "How can archived imports preserve history?",
    origin: "import",
  });
  assert.equal(revived.revived, true);
  assert.equal(revived.id, archived.id);
  const { rows: events } = await client.query(
    "SELECT event FROM public.workspace_question_events WHERE brand_key=$1 AND question_id=$2 ORDER BY id",
    [brandKey, archived.id],
  );
  assert.deepEqual(events.map((row) => row.event), ["created", "revived"]);

  const fullBrand = await makeBrand(client, "cap-questions");
  await client.query(
    `INSERT INTO public.workspace_questions(brand_key,text,origin)
     SELECT $1,'Fill question '||n||' about accounting services?','manual' FROM generate_series(1,100) n`,
    [fullBrand],
  );
  await expectError(
    client,
    "f08_question_cap",
    "SELECT public.add_workspace_question($1,'The 101st accounting question?','General','manual','active',false,NULL,NULL)",
    [fullBrand],
    /question_cap:questions/,
  );

  const topicBrand = await makeBrand(client, "cap-topics");
  await client.query(
    `INSERT INTO public.workspace_questions(brand_key,text,topic,origin)
     SELECT $1,'Question about accounting topic '||n||'?','Topic '||n,'manual' FROM generate_series(1,30) n`,
    [topicBrand],
  );
  await expectError(
    client,
    "f08_topic_cap",
    "SELECT public.add_workspace_question($1,'The 31st accounting topic question?','Topic 31','manual','active',false,NULL,NULL)",
    [topicBrand],
    /question_cap:topics/,
  );
});

{
  const brandKey = await makeBrand(pool, "revision");
  await pool.query(
    "INSERT INTO public.workspace_question_settings(brand_key,revision) VALUES($1,1)",
    [brandKey],
  );
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query("BEGIN");
    await first.query("SAVEPOINT f08_stale");
    let stale;
    try {
      await saveQuestion(first, brandKey, 0, []);
    } catch (error) {
      stale = error;
    }
    assert.match(stale?.message || "", /question_revision_conflict/);
    await first.query("ROLLBACK TO SAVEPOINT f08_stale");
    const untouched = await first.query(
      "SELECT count(*)::int AS n FROM public.workspace_questions WHERE brand_key=$1",
      [brandKey],
    );
    assert.equal(untouched.rows[0].n, 0, "stale save wrote a question");
    await first.query("ROLLBACK");

    await first.query("BEGIN");
    await second.query("BEGIN");
    const firstQuestion = id();
    const secondQuestion = id();
    await saveQuestion(first, brandKey, 1, [{
      op: "insert", id: firstQuestion, text: "First concurrent question?", topic: "General",
      origin: "manual", status: "active", branded: false, source_ref: null,
    }]);
    const competing = saveQuestion(second, brandKey, 1, [{
      op: "insert", id: secondQuestion, text: "Second concurrent question?", topic: "General",
      origin: "manual", status: "active", branded: false, source_ref: null,
    }]);
    await first.query("COMMIT");
    let conflict;
    try {
      await competing;
    } catch (error) {
      conflict = error;
    }
    assert.match(conflict?.message || "", /question_revision_conflict/);
    await second.query("ROLLBACK");
    const final = await pool.query(
      "SELECT (SELECT count(*)::int FROM public.workspace_questions WHERE brand_key=$1) AS questions, (SELECT revision::int FROM public.workspace_question_settings WHERE brand_key=$1) AS revision",
      [brandKey],
    );
    assert.deepEqual(final.rows[0], { questions: 1, revision: 2 });
    passed.push("revision");
    console.log("PASS revision");
  } finally {
    try { await first.query("ROLLBACK"); } catch { /* transaction already ended */ }
    try { await second.query("ROLLBACK"); } catch { /* transaction already ended */ }
    first.release();
    second.release();
    await pool.query("DELETE FROM public.customer_brands WHERE brand_key=$1", [brandKey]);
  }
}

await group("legacy-sync", async (client) => {
  const brandKey = await makeBrand(client, "legacy");
  const actor = await makeUser(client, "legacy");
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner')",
    [actor, brandKey],
  );
  await client.query("SET LOCAL ROLE service_role");
  const firstPayload = {
    persona: "Business buyers",
    context: { country: "in", language: "en" },
    prompts: [
      { id: "initial-id-a", question_id: null, cohort: "core", text: "Which billing tools suit teams?", topic: "Billing", origin: "manual", purpose: "recommendation", weight: 1 },
      { id: "initial-id-b", question_id: null, cohort: "core", text: "How do teams compare invoice products?", topic: "Invoices", origin: "generated", purpose: "recommendation", weight: 1 },
    ],
    reviewer: actor,
    reviewed_at: "2026-11-07T00:00:00.000Z",
    reason: null,
  };
  const artifact = await appendApprovedPanel(client, brandKey, {
    payload: firstPayload,
    expectedVersion: 0,
    actor,
  });
  const firstIds = artifact.payload.prompts.map((prompt) => prompt.question_id);
  assert.equal(artifact.payload.prompts[0].id, firstIds[0]);
  assert.equal(artifact.payload.prompts[0].question_id, firstIds[0]);
  assert.equal(artifact.sha256, artifactHash(artifact.payload), "stored hash must cover the final ID-bearing payload");

  const secondPayload = {
    ...firstPayload,
    reviewed_at: "2026-11-07T00:01:00.000Z",
    prompts: [{ ...artifact.payload.prompts[0], question_id: null }],
  };
  const secondArtifact = await appendApprovedPanel(client, brandKey, {
    payload: secondPayload,
    expectedVersion: 1,
    actor,
  });
  assert.equal(secondArtifact.version, 2);
  assert.equal(secondArtifact.payload.prompts[0].question_id, firstIds[0]);
  assert.equal(secondArtifact.sha256, artifactHash(secondArtifact.payload));
  const { rows } = await client.query(
    "SELECT text,status FROM public.workspace_questions WHERE brand_key=$1 ORDER BY text",
    [brandKey],
  );
  assert.deepEqual(rows.map((row) => row.status).sort(), ["active", "archived"]);
  const settings = await client.query(
    "SELECT persona,country,language FROM public.workspace_question_settings WHERE brand_key=$1",
    [brandKey],
  );
  assert.deepEqual(settings.rows[0], { persona: "Business buyers", country: "in", language: "en" });

  const staleBrand = await makeBrand(client, "legacy-stale");
  const staleActor = await makeUser(client, "legacy-stale");
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner')",
    [staleActor, staleBrand],
  );
  await client.query("SET LOCAL ROLE service_role");
  await appendPanel(client, staleBrand, {
    prompts: [{ text: "Which older accounting tools should remain?", topic: "History", origin: "manual" }],
    persona: "Legacy buyers",
    context: { country: "ca", language: "fr" },
    version: 0,
    state: "draft",
    actor: staleActor,
  });
  await client.query(
    "INSERT INTO public.workspace_question_settings(brand_key,revision,persona,country,language) VALUES($1,7,'Saved buyers','us','en')",
    [staleBrand],
  );
  const existingQuestionId = id();
  await client.query(
    "INSERT INTO public.workspace_questions(id,brand_key,text,topic,origin,status) VALUES($1,$2,'Which saved question should stay paused?','Saved','manual','paused')",
    [existingQuestionId, staleBrand],
  );
  const beforeQuestions = await client.query(
    "SELECT id,text,topic,origin,status FROM public.workspace_questions WHERE brand_key=$1 ORDER BY id",
    [staleBrand],
  );
  const beforeSettings = await client.query(
    "SELECT revision::int AS revision,persona,country,language,backfilled_at FROM public.workspace_question_settings WHERE brand_key=$1",
    [staleBrand],
  );
  const beforeHead = await client.query(
    "SELECT h.version,a.state,a.payload FROM public.repair_artifact_heads h JOIN public.repair_artifacts a ON a.id=h.artifact_id WHERE h.brand=$1 AND h.kind='panel' AND h.artifact_key='default'",
    [staleBrand],
  );
  const stalePayload = {
    ...firstPayload,
    persona: "New buyers",
    prompts: [{ ...firstPayload.prompts[0], text: "Which new invoice tools suit teams?" }],
  };
  await expectError(
    client,
    "f08_atomic_stale_approval",
    "SELECT public.append_approved_panel_with_questions($1,'default',0,$2,$3)",
    [staleBrand, canonicalJson(stalePayload), staleActor],
    /artifact revision conflict/,
  );
  assert.deepEqual(
    (await client.query(
      "SELECT id,text,topic,origin,status FROM public.workspace_questions WHERE brand_key=$1 ORDER BY id",
      [staleBrand],
    )).rows,
    beforeQuestions.rows,
    "stale append must roll back backfill and sync question changes",
  );
  assert.deepEqual(
    (await client.query(
      "SELECT revision::int AS revision,persona,country,language,backfilled_at FROM public.workspace_question_settings WHERE brand_key=$1",
      [staleBrand],
    )).rows,
    beforeSettings.rows,
    "stale append must not alter settings, backfill marker, or question revision",
  );
  assert.deepEqual(
    (await client.query(
      "SELECT h.version,a.state,a.payload FROM public.repair_artifact_heads h JOIN public.repair_artifacts a ON a.id=h.artifact_id WHERE h.brand=$1 AND h.kind='panel' AND h.artifact_key='default'",
      [staleBrand],
    )).rows,
    beforeHead.rows,
    "stale append must preserve the current artifact head",
  );
});

await group("backfill", async (client) => {
  const brandKey = await makeBrand(client, "backfill");
  await appendPanel(client, brandKey, {
    version: 0,
    prompts: [
      { text: "Which accounting tools work for teams?", topic: "Tools", origin: "manual" },
      { text: "How do teams manage their invoices?", topic: "Invoices", origin: "generated" },
    ],
  });
  await appendPanel(client, brandKey, {
    version: 1,
    prompts: [
      { text: "WHICH ACCOUNTING TOOLS WORK FOR TEAMS?", topic: "Tools", origin: "manual" },
      { text: "Where can teams compare invoice providers?", topic: "Invoices", origin: "generated" },
    ],
  });
  await appendPanel(client, brandKey, {
    version: 2,
    persona: "Current workspace buyers",
    context: { country: "gb", language: "en-GB" },
    prompts: [
      { text: "Where can teams compare invoice providers?", topic: "Invoices", origin: "generated" },
    ],
  });
  await client.query("SET LOCAL ROLE service_role");
  const { rows: results } = await client.query(
    "SELECT public.backfill_workspace_questions($1) AS result",
    [brandKey],
  );
  assert.equal(results[0].result.created, 3);
  assert.equal(results[0].result.active, 1);
  const { rows } = await client.query(
    "SELECT text,status,origin FROM public.workspace_questions WHERE brand_key=$1 ORDER BY text_normalized",
    [brandKey],
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.origin === "import"));
  assert.deepEqual(rows.map((row) => row.status).sort(), ["active", "archived", "archived"]);
  const settings = await client.query(
    "SELECT persona,country,language FROM public.workspace_question_settings WHERE brand_key=$1",
    [brandKey],
  );
  assert.deepEqual(settings.rows[0], {
    persona: "Current workspace buyers",
    country: "gb",
    language: "en-gb",
  });
  const { rows: second } = await client.query(
    "SELECT public.backfill_workspace_questions($1) AS result",
    [brandKey],
  );
  assert.equal(second[0].result.skipped, true);
  assert.equal((await client.query(
    "SELECT count(*)::int AS n FROM public.workspace_questions WHERE brand_key=$1",
    [brandKey],
  )).rows[0].n, 3);
});

await group("scan-snapshot", async (client) => {
  const brandKey = await makeBrand(client, "snapshot");
  const actor = await makeUser(client, "snapshot");
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner')",
    [actor, brandKey],
  );
  await client.query("SET LOCAL ROLE service_role");
  const questionId = id();
  await client.query(
    "INSERT INTO public.workspace_question_settings(brand_key,revision) VALUES($1,1)",
    [brandKey],
  );
  await client.query(
    "INSERT INTO public.workspace_questions(id,brand_key,text,topic,origin) VALUES($1,$2,$3,'Billing','manual')",
    [questionId, brandKey, "Which billing tools support small teams?"],
  );
  const prompt = {
    id: questionId,
    question_id: questionId,
    cohort: "core",
    text: "Which billing tools support small teams?",
    topic: "Billing",
    origin: "manual",
    purpose: "recommendation",
    weight: 1,
  };
  await appendPanel(client, brandKey, { prompts: [prompt], state: "approved", actor });
  await client.query(
    "INSERT INTO public.scan_schedules(brand,display_name,cadence,enabled,next_run_at) VALUES($1,'F08 QA','daily',true,now()-interval '1 minute')",
    [brandKey],
  );
  const { rows: enqueued } = await client.query(
    "SELECT public.enqueue_measurement_window($1,now()) AS result",
    [brandKey],
  );
  assert.equal(enqueued[0].result.started, true);
  const { rows: before } = await client.query(
    "SELECT panel_snapshot FROM public.scan_jobs WHERE id=$1",
    [enqueued[0].result.job_id],
  );
  const snapshot = before[0].panel_snapshot;
  assert.equal(snapshot.payload.prompts[0].question_id, questionId);
  await saveQuestion(client, brandKey, 1, [{ op: "update", id: questionId, topic: "Renamed after approval" }]);
  const { rows: after } = await client.query(
    "SELECT panel_snapshot FROM public.scan_jobs WHERE id=$1",
    [enqueued[0].result.job_id],
  );
  assert.deepEqual(after[0].panel_snapshot, snapshot, "editing the working set must not mutate a queued scan snapshot");
});

await group("approve", async (client) => {
  const brandKey = await makeBrand(client, "approve");
  const actor = await makeUser(client, "approve");
  await client.query(
    "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner')",
    [actor, brandKey],
  );
  await client.query("SET LOCAL ROLE service_role");

  // Initial legacy approved panel v1
  const initialPrompt = {
    id: id(),
    question_id: id(),
    cohort: "core",
    text: "Which initial accounting software works for teams?",
    topic: "Tools",
    origin: "manual",
    purpose: "recommendation",
    weight: 1,
  };
  const v1 = await appendPanel(client, brandKey, {
    prompts: [initialPrompt],
    version: 0,
    state: "approved",
    actor,
  });
  assert.equal(v1.version, 1);
  assert.equal(v1.state, "approved");
  assert.equal(v1.kind, "panel");
  assert.equal(v1.artifact_key, "default");

  // Working set settings and questions for F08
  await client.query(
    "INSERT INTO public.workspace_question_settings(brand_key,revision,persona,country,language) VALUES($1,1,'Finance buyers','in','en')",
    [brandKey],
  );
  const q1Id = id();
  const q2Id = id();
  await client.query(
    "INSERT INTO public.workspace_questions(id,brand_key,text,topic,origin,status,branded) VALUES($1,$2,'Which new accounting software works for teams?','Tools','ai_generate','active',false), ($3,$2,'Is F08 approve good?','General','manual','active',true)",
    [q1Id, brandKey, q2Id],
  );

  // F08 approval constructs payload and appends via append_repair_artifact
  const prompts = [
    {
      id: q1Id,
      question_id: q1Id,
      text: "Which new accounting software works for teams?",
      topic: "Tools",
      origin: "generated",
      workspace_origin: "ai_generate",
      cohort: "core",
      weight: 1,
      purpose: "recommendation",
    },
    {
      id: q2Id,
      question_id: q2Id,
      text: "Is F08 approve good?",
      topic: "General",
      origin: "manual",
      workspace_origin: "manual",
      cohort: "core",
      weight: 1,
      purpose: "diagnostic",
    },
  ];
  const payload = {
    persona: "Finance buyers",
    context: { country: "in", language: "en", device: "desktop", session_policy: "fresh_anonymous" },
    source: "workspace_questions",
    workspace_revision: 1,
    prompts,
    reviewer: actor,
    reviewed_at: new Date().toISOString(),
    reason: null,
  };
  const hash = artifactHash(payload);

  const { rows: approveRows } = await client.query(
    "SELECT public.append_repair_artifact($1,'panel','default',1,'approved',$2::jsonb,$3,$4) AS artifact",
    [brandKey, JSON.stringify(payload), hash, actor],
  );
  const v2 = approveRows[0].artifact;

  // F08-AC-25: produces version n+1 of panel/default with same kind/key/state as legacy approval
  assert.equal(v2.version, 2);
  assert.equal(v2.state, "approved");
  assert.equal(v2.kind, "panel");
  assert.equal(v2.artifact_key, "default");
  assert.equal(v2.brand, brandKey);

  // Check stored artifact in repair_artifacts table
  const { rows: artRows } = await client.query(
    "SELECT id, hash, state, payload FROM public.repair_artifacts WHERE id=$1",
    [v2.id],
  );
  assert.equal(artRows.length, 1);
  assert.equal(artRows[0].hash, hash);
  assert.equal(artRows[0].state, "approved");

  // Check head
  const { rows: headRows } = await client.query(
    "SELECT version, artifact_id FROM public.repair_artifact_heads WHERE brand=$1 AND kind='panel' AND artifact_key='default'",
    [brandKey],
  );
  assert.equal(headRows[0].version, 2);
  assert.equal(headRows[0].artifact_id, v2.id);

  // Record approved events and bump revision
  const events = [
    { question_id: q1Id, event: "approved", detail: { panel_version: 2 } },
    { question_id: q2Id, event: "approved", detail: { panel_version: 2 } },
  ];
  const { rows: saveRows } = await client.query(
    "SELECT public.save_workspace_questions($1,1,'[]'::jsonb,$2::jsonb,NULL,$3) AS result",
    [brandKey, JSON.stringify(events), actor],
  );
  assert.equal(saveRows[0].result.revision, 2);

  const { rows: eventRows } = await client.query(
    "SELECT question_id, event, revision FROM public.workspace_question_events WHERE brand_key=$1 ORDER BY created_at",
    [brandKey],
  );
  assert.equal(eventRows.length, 2);
  assert.equal(eventRows[0].event, "approved");
  assert.equal(eventRows[1].event, "approved");
});

await pool.end();
if (targetGroup) {
  console.log(`ok 1 group (${targetGroup})`);
} else {
  console.log(`ok ${passed.length} groups: ${passed.join(", ")}`);
}
