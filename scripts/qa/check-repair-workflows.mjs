#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import {createMetric,measurementContext} from "../../src/shared/scoring/metricContract.js";
import {qualifyVisibilityPoint} from "../../src/shared/analytics/visibilitySeries.js";
import {
  contentHash,
  artifactHash,
  validatePanel,
} from "../../src/server/repairs/workflow.js";
if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
)
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
const pool = new pg.Pool({ max: 12 });
const q = (sql, values = []) => pool.query(sql, values);
const passed = [];
const id = () => crypto.randomUUID();
const brand = `qa-${id()}.example`,
  other = `qa-${id()}.example`,
  actor = id(),
  outsider = id();
async function rpc(name, values) {
  const entries = Object.entries(values);
  const r = await q(
    `select ${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) result`,
    entries.map(([key, v]) =>
      name === "set_probe_rollout" && key === "p_brands" ? v : v && typeof v === "object" ? JSON.stringify(v) : v,
    ),
  );
  return r.rows[0].result;
}
async function test(name, fn) {
  await fn();
  passed.push(name);
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
async function fixtureItem() {
  const job = id(),
    item = id();
  await q(
    "insert into content_jobs(id,brand,playbook,status,cost_total) values($1,$2,'geo_article','awaiting_approval',0)",
    [job, brand],
  );
  await q(
    "insert into content_items(id,job_id,brand,playbook,title,body_md,research_pack,status) values($1,$2,$3,'geo_article','Exact draft',$4,'{}','awaiting_approval')",
    [
      item,
      job,
      brand,
      "Approved source-grounded content for the current saved draft. ".repeat(
        8,
      ),
    ],
  );
  return (await q("select * from content_items where id=$1", [item])).rows[0];
}
const hashOf = (item) => contentHash(item.title, item.body_md);
async function check(item) {
  const h = hashOf(item);
  await q(
    "update content_items set rubric=jsonb_build_object('check',jsonb_build_object('passed',true,'content_hash',$2::text,'research_snapshot',research_pack)) where id=$1",
    [item.id, h],
  );
  return h;
}
async function approve(item, h) {
  return rpc("decide_checked_content", {
    p_item: item.id,
    p_brand: brand,
    p_version: item.content_version,
    p_hash: h,
    p_status: "approved",
    p_comment: "Reviewed evidence",
    p_actor: actor,
  });
}
async function publish(item, h, key = id()) {
  return rpc("record_verified_publication", {
    p_item: item.id,
    p_brand: brand,
    p_version: item.content_version,
    p_hash: h,
    p_url: `https://${brand}/page-${item.id}`,
    p_verification: { matched: true, status: 200, content_hash: h },
    p_key: key,
    p_actor: actor,
  });
}
try {
  await q("insert into auth.users(id) values($1),($2)", [actor, outsider]);
  await q(
    "insert into customer_brands(brand_key,display_name,website,website_host) values($1,$1,$2,$1),($3,$3,$4,$3)",
    [brand, `https://owned-${brand}`, other, `https://${other}`],
  );
  await q(
    "insert into customer_brand_memberships(user_id,brand_key) values($1,$2),($3,$4)",
    [actor, brand, outsider, other],
  );
  const panel = validatePanel({
    persona: "QA buyers",
    context: { country: "in" },
    prompts: Array.from({ length: 30 }, (_, i) => ({
      text: `Which provider serves sector ${i} buyers?`,
      duplicate_reason: "Distinct fixture segment",
      origin: "manual",
    })),
  });
  const args = {
    p_brand: brand,
    p_kind: "panel",
    p_key: "default",
    p_expected: 0,
    p_state: "approved",
    p_payload: panel,
    p_hash: artifactHash(panel),
    p_actor: actor,
  };
  await test("R14-D: competing panel edits have one immutable version; cross-tenant reads and writes denied", async () => {
    const race = await Promise.allSettled([
      rpc("append_repair_artifact", args),
      rpc("append_repair_artifact", args),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (
        await asUser(actor, "select * from repair_artifacts where brand=$1", [
          brand,
        ])
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await asUser(
          outsider,
          "select * from repair_artifacts where brand=$1",
          [brand],
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      rpc("append_repair_artifact", {
        ...args,
        p_expected: 1,
        p_actor: outsider,
      }),
    );
  });
  await test("R11-D: simultaneous scheduled enqueue creates one job and records every missed opportunity", async () => {
    const due = new Date(Date.now() - 3 * 86400_000);
    await q(
      "insert into scan_schedules(brand,display_name,cadence,enabled,next_run_at) values($1,$1,'daily',true,$2)",
      [brand, due],
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        rpc("enqueue_measurement_window", {
          p_brand: brand,
          p_now: new Date().toISOString(),
        }),
      ),
    );
    assert.equal(results.filter((r) => r.started).length, 1);
    const rows = (
      await q("select * from measurement_windows where brand=$1", [brand])
    ).rows;
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((r) => r.disposition === "missed").length, 3);
    const job = (
      await q("select * from scan_jobs where id=$1", [
        rows.find((r) => r.job_id).job_id,
      ])
    ).rows[0];
    assert.equal(job.panel_snapshot.version, 1);
    assert.equal(job.measurement_context.country, "in");
      assert.equal(job.url,`https://owned-${brand}`);
  });
  await test("R17-D: stale review cannot approve edited text or leave feedback; all writers reject unchecked approval", async () => {
    const item = await fixtureItem(),
      h = await check(item);
    await q(
      "update content_items set body_md=body_md||' Changed.' where id=$1",
      [item.id],
    );
    await assert.rejects(approve(item, h));
    await assert.rejects(
      q("update content_items set status='approved' where id=$1", [item.id]),
    );
    assert.equal(
      (await q("select * from content_feedback where item_id=$1", [item.id]))
        .rows.length,
      0,
    );
    const changed = (
      await q("select * from content_items where id=$1", [item.id])
    ).rows[0];
    assert.equal(changed.content_version, 2);
    assert.equal(changed.rubric.check, undefined);
  });
  await test("R17-D: paid check races reserve once; expired checks cannot approve later content and retain uncertainty", async () => {
    const item = await fixtureItem();
    const claimArgs = {
      p_item: item.id,
      p_brand: brand,
      p_version: item.content_version,
      p_hash: item.content_hash,
      p_key: "one-version",
      p_reserve: 0.02,
      p_cap: 0.03,
    };
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => rpc("claim_content_check", claimArgs)),
    );
    assert.equal(claims.filter((c) => c.granted).length, 1);
    const exhausted = await rpc("claim_content_check", {
      ...claimArgs,
      p_key: "another-call",
    });
    assert.equal(exhausted.state, "budget_exhausted");
    await q(
      "update content_check_claims set lease_until=now()-interval '1 minute' where item_id=$1",
      [item.id],
    );
    const result = await rpc("finish_content_check", {
      p_item: item.id,
      p_brand: brand,
      p_key: "one-version",
      p_token: claims.find((c) => c.granted).token,
      p_check: {
        passed: true,
        content_hash: item.content_hash,
        research_snapshot: {},
      },
      p_cost: 0.01,
    });
    assert.equal(result.state, "unknown");
    assert.equal(result.applied, false);
    assert.equal(
      (
        await q(
          "select charged_usd from content_check_claims where item_id=$1",
          [item.id],
        )
      ).rows[0].charged_usd,
      null,
    );
  });
  await test("R18-D: publication failure rolls back item, job, event and version artifact; retry is idempotent", async () => {
    const item = await fixtureItem(),
      h = await check(item);
    assert.equal(h, item.content_hash);
    await approve(item, h);
    await q(
      `create or replace function qa_fail_publication() returns trigger language plpgsql as $$begin if NEW.id='${item.job_id}'::uuid and NEW.status='published' then raise exception 'injected write failure';end if;return NEW;end$$;create trigger qa_fail_publication before update on content_jobs for each row execute function qa_fail_publication()`,
    );
    await assert.rejects(publish(item, h));
    assert.equal(
      (await q("select status from content_items where id=$1", [item.id]))
        .rows[0].status,
      "approved",
    );
    assert.equal(
      (await q("select * from content_events where brand=$1", [brand])).rows
        .length,
      0,
    );
    assert.equal(
      (
        await q(
          "select * from repair_artifacts where brand=$1 and kind='publication'",
          [brand],
        )
      ).rows.length,
      0,
    );
    await q(
      "drop trigger qa_fail_publication on content_jobs;drop function qa_fail_publication()",
    );
    const key = id();
    const first = await publish(item, h, key),
      second = await publish(item, h, key);
    assert.deepEqual(second, first);
    assert.equal(first.indexing, null);
    assert.equal(
      (await q("select * from content_events where brand=$1", [brand])).rows
        .length,
      1,
    );
  });
  await test("R03-09/10-D: concurrent report identity, failed materialization rollback, and idempotent recovery", async () => {
    const job = id();
    await q("insert into scan_jobs(id,brand,status) values($1,$2,'scoring')", [
      job,
      `report-${brand}`,
    ]);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        q(
          "insert into scans(brand,origin_job_id) values($1,$2) on conflict(origin_job_id) do nothing",
          [brand, job],
        ),
      ),
    );
    const scans = (await q("select * from scans where origin_job_id=$1", [job]))
      .rows;
    assert.equal(scans.length, 1);
    const scan = scans[0].id,
      result = id();
    await q(
      "insert into prompt_results(id,job_id,brand,engine,query) values($1,$2,$3,'chatgpt','A question')",
      [result, job, brand],
    );
    const args = {
      p_job: job,
      p_scan: scan,
      p_citations: [
        {
          job_id: job,
          scan_id: scan,
          result_id: result,
          brand,
          engine: "chatgpt",
          url: `https://${brand}/source`,
          domain: brand,
          rank: 1,
          is_self: true,
        },
      ],
      p_brands: [
        {
          result_id: result,
          scan_id: scan,
          brand,
          name: "QA Brand",
          is_self: true,
          mentioned: true,
        },
      ],
      p_metrics: [
        {
          brand,
          date: "2026-10-20",
          engine: "all",
          scan_id: scan,
          visibility_pct: 20,
        },
      ],
      p_record: { summary_stats: { terminal_outcome: { outcome: "partial" } } },
    };
    await assert.rejects(
      rpc("materialize_scan_report", {
        ...args,
        p_metrics: [{ ...args.p_metrics[0], brand: null }],
      }),
    );
    assert.equal(
      (await q("select * from citations where job_id=$1", [job])).rows.length,
      0,
    );
    assert.equal(
      (await q("select scan_id from prompt_results where job_id=$1", [job]))
        .rows[0].scan_id,
      null,
    );
    await Promise.all([
      rpc("materialize_scan_report", args),
      rpc("materialize_scan_report", args),
    ]);
    assert.equal(
      (await q("select * from citations where job_id=$1", [job])).rows.length,
      1,
    );
    assert.equal(
      (await q("select * from result_brands where scan_id=$1", [scan])).rows
        .length,
      1,
    );
    assert.equal(
      (await q("select status from scan_jobs where id=$1", [job])).rows[0]
        .status,
      "complete",
    );
  });
  await test("R06-D: evidence, check reservations and provider incidents have no customer or anonymous direct grants", async () => {
    for (const role of ["anon", "authenticated"])
      for (const table of [
        "measurement_evidence",
        "measurement_incidents",
        "content_check_claims",
      ]) {
        const r = await q(
          "select has_table_privilege($1,$2,'SELECT') allowed",
          [role, table],
        );
        assert.equal(r.rows[0].allowed, false);
      }
    assert.equal(
      (
        await asUser(
          outsider,
          "select * from measurement_windows where brand=$1",
          [brand],
        )
      ).rows.length,
      0,
    );
  });
  await test("R02-D: paused rollout admits one owned QA workspace and bounded canaries; rollback blocks new attempts but accepts in-flight settlement", async()=>{
    const jobA=id(),jobB=id(),prefix=`rollout-${id()}`;
    await q("insert into scan_jobs(id,brand,brand_key,status) values($1,$2,$2,'complete'),($3,$4,$4,'complete')",[jobA,brand,jobB,other]);
    await q("update scan_jobs set checkpoint=jsonb_build_object('prompt_key',brand_key) where id=any($1::uuid[])",[[jobA,jobB]]);
    const seed=async (suffix,job,purpose="scan")=>{
      const observation=`${prefix}-${suffix}`;
      await rpc("seed_probe_observations",{p_rows:[{id:observation,job_id:job,purpose,engine:"chatgpt",query:`QA rollout ${suffix}`,context:purpose==="canary"?{budget_scope:`${prefix}-${suffix}`,max_requests:1,request_units:1}:{},config_version:"qa-fixture",circuit_key:observation,deadline_at:new Date(Date.now()+600_000).toISOString()}]});
      return observation;
    };
    const a=await seed("a",jobA),b=await seed("b",jobB),canary=await seed("canary",null,"canary"),stopped=await seed("stopped",null,"canary");
    const claim=o=>rpc("claim_probe_dispatch",{p_id:o,p_reserve:0.1,p_scan_cap:1,p_day_cap:null,p_lease_seconds:120});
    try{
      await rpc("set_probe_rollout",{p_paused:true,p_canaries:true,p_brands:[brand]});
      const allowed=await claim(a),denied=await claim(b),canaryClaim=await claim(canary);
      assert.equal(allowed.granted,true);assert.equal(canaryClaim.granted,true);assert.equal(denied.granted,false);assert.equal(denied.reason,"dispatch_paused");
      assert.equal((await q("select attempt_count from probe_observations where id=$1",[b])).rows[0].attempt_count,0);
      await rpc("set_probe_rollout",{p_paused:true,p_canaries:false,p_brands:[]});
      assert.equal((await claim(stopped)).granted,false);
      const saved=await rpc("finish_probe_dispatch",{p_id:a,p_token:allowed.lease_token,p_result:{engine:"chatgpt",text:"QA fixture",answer_present:true,brand_mentioned_in_text:false,brand_cited:false,is_branded_query:false,brands:[],cost:0},p_state:"answered",p_failure:null,p_next_at:null});
      assert.equal(saved.accepted,true);
      await assert.rejects(()=>asUser(actor,"select set_probe_rollout(false,false,'{}')"),/permission denied/);
      await assert.rejects(()=>rpc("set_probe_rollout",{p_paused:true,p_canaries:false,p_brands:[brand,other]}),/invalid owned rollout scope/);
    }finally{await rpc("set_probe_rollout",{p_paused:false,p_canaries:false,p_brands:[]});}
  });
  await test("R04-D: private evidence bucket accepts JSON and the read-only storage contract is present", async()=>{
    const bucket=(await q("select public,allowed_mime_types from storage.buckets where id='probe-evidence'")).rows[0];
    assert.equal(bucket.public,false);assert.ok(bucket.allowed_mime_types.includes("application/json"));
    assert.equal((await q("select measurement_storage_ready() ready")).rows[0].ready,true);
  });
  await test("QA-D: last-owner protection remains active and only validated fixture membership can be demoted for workspace cleanup", async()=>{
    const fixtureBrand=`qa-cleanup-${id()}.example`;
    await q("insert into customer_brands(brand_key,display_name,website,website_host) values($1,'QA cleanup','https://cleanup.example','cleanup.example')",[fixtureBrand]);
    await q("insert into customer_brand_memberships(user_id,brand_key,role) values($1,$2,'owner')",[actor,fixtureBrand]);
    await assert.rejects(()=>q("delete from customer_brand_memberships where brand_key=$1",[fixtureBrand]),/last owner/);
    await q("update customer_brand_memberships set role='member' where brand_key=$1 and user_id=$2",[fixtureBrand,actor]);
    await q("delete from customer_brands where brand_key=$1",[fixtureBrand]);
    assert.equal((await q("select count(*)::int n from customer_brand_memberships where brand_key=$1",[fixtureBrand])).rows[0].n,0);
    assert.equal((await q("select count(*)::int n from customer_brands where brand_key=$1",[brand])).rows[0].n,1);
  });
  await test("R05-19/20-D: repeated daily materialization retains one versioned zero; historical scalars remain unqualified",async()=>{
    const job=id(),scan=id(),legacy=id();
    const brand=`qa-trend-${id()}.example`;
    await q("insert into customer_brands(brand_key,display_name,website,website_host) values($1,$1,'https://trend.example','trend.example')",[brand]);
    await q("insert into customer_brand_memberships(user_id,brand_key,role) values($1,$2,'owner')",[actor,brand]);
    const metric=createMetric({metricId:"observed_exposure",numerator:0,denominator:30,eligiblePromptIds:Array.from({length:30},(_,i)=>`qa-question-${i}`),collection:{valid:30,planned:30},context:measurementContext({panelVersion:"qa-fixed",surfaceVersion:"qa-model-api",market:"in",modelPolicyVersion:"qa-v1",engineCohort:["chatgpt"]})});
    await q("insert into scan_jobs(id,brand,brand_key,status) values($1,$2,$2,'scoring')",[job,brand]);
    await q("insert into scans(id,brand,brand_key,origin_job_id) values($1,$2,$2,$3)",[scan,brand,job]);
    const record={visibility_pct:0,prompts_tracked:30,prompts_mentioned:0,scoring_version:"qa-r05",summary_stats:{headline_metric:metric}};
    const args={p_job:job,p_scan:scan,p_citations:[],p_brands:[],p_metrics:[{brand,date:"2026-10-21",engine:"all",scan_id:scan,visibility_pct:0,prompts_total:30,prompts_answered:30,prompts_mentioned:0,prompt_set_id:"qa-fixed"}],p_record:record};
    await rpc("materialize_scan_report",args);await rpc("materialize_scan_report",args);
    const rows=(await q("select m.*,s.raw_results->'summary_stats'->'headline_metric' as headline_metric from brand_metrics_daily m join scans s on s.id=m.scan_id where m.brand=$1 and m.date='2026-10-21' and m.engine='all'",[brand])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].prompts_answered,30);assert.deepEqual(rows[0].headline_metric,metric);
    assert.equal(qualifyVisibilityPoint(rows[0],rows[0]).visibility_pct,0);
    await q("insert into scans(id,brand,brand_key,visibility_pct,raw_results) values($1,$2,$2,87,$3)",[legacy,brand,JSON.stringify({legacy_snapshot:true})]);
    await q("insert into brand_metrics_daily(brand,date,engine,scan_id,visibility_pct) values($1,'2026-10-22','all',$2,87)",[brand,legacy]);
    const old=(await q("select m.*,s.raw_results,s.raw_results->'summary_stats'->'headline_metric' as headline_metric from brand_metrics_daily m join scans s on s.id=m.scan_id where m.scan_id=$1",[legacy])).rows[0];
    const projected=qualifyVisibilityPoint(old,old);assert.equal(projected.visibility_pct,null);assert.equal(projected.stored_visibility_pct,87);assert.equal(projected.metric_state,"legacy_unknown");assert.deepEqual(old.raw_results,{legacy_snapshot:true});
  });
  const manifest = {
    suite: "real-postgresql-repair-workflows",
    executed_at: new Date().toISOString(),
    database: "isolated-loopback-qa",
    passed,
    failures: [],
    qualification:
      "Only the listed database behaviors; hosted Auth/Storage and browser acceptance are separate.",
  };
  await writeFile(
    "docs/audits/2026-10-16/repair-workflow-database-evidence.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
} finally {
  await pool.end();
}
