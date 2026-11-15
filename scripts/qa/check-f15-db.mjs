#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

if (!["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) || !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") || process.env.DATABASE_URL) {
  throw Error("Explicit loopback _qa/_uat database required; DATABASE_URL refused");
}
const pool = new pg.Pool({ max: 1 });
const passed = [];
const id = () => crypto.randomUUID();
const onlyIdx = process.argv.indexOf("--only");
const onlyGroup = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

async function group(name, fn) {
  if (onlyGroup && onlyGroup !== name) return;
  const c = await pool.connect();
  try { await c.query("BEGIN"); await fn(c); await c.query("ROLLBACK"); passed.push(name); console.log(`PASS ${name}`); }
  catch (error) { try { await c.query("ROLLBACK"); } catch { /* keep original error */ } throw error; }
  finally { c.release(); }
}
async function brand(c, label, user = null) {
  const key = `qa-f15-${label}-${id()}.example`;
  await c.query("INSERT INTO customer_brands(brand_key,display_name,website,website_host) VALUES($1,$2,$3,$4)", [key, label, `https://${key}`, key]);
  if (user) await c.query("INSERT INTO customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner')", [user, key]);
  return key;
}
async function user(c) { const uid = id(); await c.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())", [uid, `${uid}@f15.test`]); return uid; }
async function config(c, brandKey, opts = {}) {
  const configId = opts.id ?? id();
  await c.query("INSERT INTO rank_tracking_configs(id,brand_key,domain,location_code,language_code,location_name,devices,serp_depth,schedule_interval,next_check_at,created_by) VALUES($1,$2,$3,2840,'en',NULL,$4,40,$5,$6,$7)",
    [configId, brandKey, `${configId}.example`, opts.devices ?? "mobile", opts.interval ?? "weekly", opts.next ?? new Date(Date.now() - 60_000).toISOString(), opts.actor ?? null]);
  return configId;
}
async function createRun(c, brandKey, configId, runId = id(), maxUsd = 1, actor = null) {
  const { rows } = await c.query("SELECT try_create_rank_run($1,$2,$3,'manual','live',$4,'{}'::uuid[],$5) AS ok", [brandKey, configId, runId, maxUsd, actor]);
  return rows[0].ok;
}

async function main() {
  await group("schema", async (c) => {
    const names = ["rank_tracking_configs","rank_tracking_keywords","rank_check_runs","rank_snapshots","rank_check_tasks","rank_keyword_questions"];
    const { rows } = await c.query("SELECT to_regclass('public.' || x) AS obj FROM unnest($1::text[]) x", [names]);
    assert.equal(rows.filter((x) => x.obj !== null).length, 6);
    const fk = await c.query("SELECT 1 FROM pg_constraint WHERE conrelid='public.rank_snapshots'::regclass AND confrelid='public.rank_tracking_keywords'::regclass AND contype='f'");
    assert.equal(fk.rowCount, 0, "snapshots preserve history after keyword removal");
    const idx = await c.query("SELECT to_regclass('public.rank_check_runs_one_active_per_config_idx') AS active");
    assert.ok(idx.rows[0].active);
  });

  await group("rls", async (c) => {
    const ua = await user(c), ub = await user(c), ba = await brand(c,"rls-a",ua), bb = await brand(c,"rls-b",ub);
    const ca = await config(c,ba), cb = await config(c,bb);
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ua]);
    assert.equal((await c.query("SELECT count(*)::int n FROM rank_tracking_configs")).rows[0].n,1);
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ub]);
    assert.equal((await c.query("SELECT count(*)::int n FROM rank_tracking_configs")).rows[0].n,1);
    assert.notEqual(ca,cb);
  });

  await group("keywords", async (c) => {
    const b = await brand(c,"keywords"), cfg = await config(c,b);
    const rows = Array.from({length:1005},(_,i)=>({keyword:`keyword ${String(i).padStart(4,"0")}`,match_case:false}));
    const added = await c.query("SELECT add_rank_tracking_keywords($1,$2,$3::jsonb) ids",[b,cfg,JSON.stringify(rows)]);
    assert.equal(added.rows[0].ids.length,1000);
    assert.equal((await c.query("SELECT count(*)::int n FROM rank_tracking_keywords WHERE config_id=$1",[cfg])).rows[0].n,1000);
    const cfg2 = await config(c,b); await c.query("SELECT add_rank_tracking_keywords($1,$2,$3::jsonb)",[b,cfg2,JSON.stringify([{keyword:"alpha"},{keyword:"alpha"}])]);
    const duplicate = await c.query("SELECT add_rank_tracking_keywords($1,$2,$3::jsonb) ids",[b,cfg2,JSON.stringify([{keyword:"alpha"},{keyword:"beta"}])]);
    assert.equal(duplicate.rows[0].ids.length,1);
    await c.query("SAVEPOINT lowercase_check"); let caught;
    try { await c.query("INSERT INTO rank_tracking_keywords(brand_key,config_id,keyword,match_case) VALUES($1,$2,'UPPER',false)",[b,cfg2]); } catch (e) { caught=e; }
    assert.equal(caught?.code,"23514"); await c.query("ROLLBACK TO SAVEPOINT lowercase_check");
  });

  await group("active", async (c) => {
    const b=await brand(c,"active"),cfg=await config(c,b),r1=id(),r2=id(),r3=id();
    assert.equal(await createRun(c,b,cfg,r1),true);assert.equal(await createRun(c,b,cfg,r2),false);
    await c.query("UPDATE rank_check_runs SET status='completed',completed_at=now() WHERE id=$1",[r1]);
    assert.equal(await createRun(c,b,cfg,r3),true);
  });

  await group("reserve", async (c) => {
    const b=await brand(c,"reserve"),cfg=await config(c,b),rid=id();assert.equal(await createRun(c,b,cfg,rid,1),true);
    assert.equal((await c.query("SELECT rank_check_reserve($1,$2,0.60) ok",[b,rid])).rows[0].ok,true);
    assert.equal((await c.query("SELECT rank_check_reserve($1,$2,0.50) ok",[b,rid])).rows[0].ok,false);
  });

  await group("results", async (c) => {
    const b=await brand(c,"results"),cfg=await config(c,b),keyword=id(),r1=id(),r2=id();
    await createRun(c,b,cfg,r1);await c.query("UPDATE rank_check_runs SET status='completed',started_at='2026-10-01T00:00:00Z',completed_at=now() WHERE id=$1",[r1]);
    await c.query("INSERT INTO rank_tracking_keywords(id,brand_key,config_id,keyword,match_case) VALUES($1,$2,$3,'alpha',false)",[keyword,b,cfg]);
    await c.query("INSERT INTO rank_snapshots(brand_key,run_id,tracking_keyword_id,keyword,device,position,checked_at) VALUES($1,$2,$3,'alpha','mobile',5,'2026-10-01T01:00:00Z')",[b,r1,keyword]);
    await createRun(c,b,cfg,r2);await c.query("UPDATE rank_check_runs SET status='completed',started_at='2026-10-02T00:00:00Z',completed_at=now() WHERE id=$1",[r2]);
    await c.query("INSERT INTO rank_snapshots(brand_key,run_id,tracking_keyword_id,keyword,device,position,checked_at) VALUES($1,$2,$3,'alpha','mobile',2,'2026-10-02T01:00:00Z')",[b,r2,keyword]);
    const latest=await c.query("SELECT position FROM rank_latest_snapshots($1,$2,NULL) WHERE tracking_keyword_id=$3 AND device='mobile'",[b,cfg,keyword]);assert.equal(latest.rows[0].position,2);
    const before=await c.query("SELECT position FROM rank_latest_snapshots($1,$2,'2026-10-01T23:59:59Z') WHERE tracking_keyword_id=$3 AND device='mobile'",[b,cfg,keyword]);assert.equal(before.rows[0].position,5);
    const earliest=await c.query("SELECT position FROM rank_earliest_snapshots($1,$2,$3::uuid[])",[b,cfg,[keyword]]);assert.equal(earliest.rows[0].position,5);
    assert.equal((await c.query("SELECT position FROM rank_best_positions($1,$2) WHERE tracking_keyword_id=$3",[b,cfg,keyword])).rows[0].position,2);
  });

  await group("trend", async (c) => {
    const b=await brand(c,"trend"),cfg=await config(c,b),k1=id(),k2=id(),r1=id(),r2=id(),subset=id();
    const emptyRun=id();
    for(const [rid,date,isSubset] of [[emptyRun,"2026-09-30T00:00:00Z",false],[r1,"2026-10-01T00:00:00Z",false],[r2,"2026-10-02T00:00:00Z",false],[subset,"2026-10-03T00:00:00Z",true]]){
      await c.query("INSERT INTO rank_check_runs(id,brand_key,config_id,trigger,method,status,domain,location_code,language_code,devices,serp_depth,keywords_total,is_subset_run,approved_max_usd,started_at,completed_at) VALUES($1,$2,$3,'manual','live','completed',$4,2840,'en','both',40,5,$5,1,$6,$6)",[rid,b,cfg,`${cfg}.example`,isSubset,date]);
    }
    await c.query("INSERT INTO rank_snapshots(brand_key,run_id,tracking_keyword_id,keyword,device,position,serp_features) VALUES($1,$2,$3,'a','mobile',2,'{}'),($1,$2,$4,'b','mobile',5,ARRAY['ai_overview']),($1,$2,$5,'c','mobile',15,'{}'),($1,$2,$6,'d','mobile',NULL,'{}')",[b,r2,k1,k2,id(),id()]);
    await c.query("INSERT INTO rank_snapshots(brand_key,run_id,tracking_keyword_id,keyword,device,position) VALUES($1,$2,$3,'prior','mobile',3)",[b,r1,id()]);
    await c.query("INSERT INTO rank_snapshots(brand_key,run_id,tracking_keyword_id,keyword,device,position) VALUES($1,$2,$3,'a','mobile',1)",[b,subset,k1]);
    const points=await c.query("SELECT * FROM rank_config_trend($1,$2,'mobile','2026-10-01T00:00:00Z')",[b,cfg]);assert.equal(points.rowCount,2);
    const latest=points.rows.at(-1);assert.equal(latest.total,4);assert.deepEqual([latest.top3,latest.top4to10,latest.top11to20,latest.ai_overview],[1,1,1,1]);assert.equal(latest.keywords_total-latest.total,1);
    const matrix=await c.query("SELECT * FROM rank_position_matrix($1,$2,'mobile',2)",[b,cfg]);assert.equal(matrix.rowCount,5);assert.ok(matrix.rows.every(x=>x.run_id!==subset));
    const desktopPoints=await c.query("SELECT * FROM rank_config_trend($1,$2,'desktop','2026-10-01T00:00:00Z')",[b,cfg]);
    assert.equal(desktopPoints.rowCount,2);
    assert.ok(desktopPoints.rows.every((point)=>point.total===0&&point.keywords_total===5));
    const desktopMatrix=await c.query("SELECT * FROM rank_position_matrix($1,$2,'desktop',2)",[b,cfg]);
    assert.equal(desktopMatrix.rowCount,5);
    assert.ok(desktopMatrix.rows.every((cell)=>cell.position===null));
    const emptyMatrix=await c.query("SELECT * FROM rank_position_matrix($1,$2,'desktop',3)",[b,cfg]);
    assert.equal(emptyMatrix.rowCount,6);
    assert.deepEqual(emptyMatrix.rows.find((cell)=>cell.run_id===emptyRun),{
      run_id: emptyRun,
      checked_at: new Date("2026-09-30T00:00:00Z"),
      tracking_keyword_id: null,
      position: null,
    });
  });

  await group("retention", async (c) => {
    const b=await brand(c,"retention"),cfg=await config(c,b),old=id(),active=id();
    await c.query("INSERT INTO rank_check_runs(id,brand_key,config_id,trigger,method,status,domain,location_code,language_code,devices,serp_depth,approved_max_usd,started_at,completed_at) VALUES($1,$2,$3,'manual','live','failed',$4,2840,'en','mobile',40,1,'2020-01-01',now()),($5,$2,$3,'manual','live','running',$4,2840,'en','mobile',40,1,now(),NULL)",[old,b,cfg,`${cfg}.example`,active]);
    await c.query("INSERT INTO rank_check_tasks(brand_key,run_id,round,tracking_keyword_id,keyword,device,created_at) VALUES($1,$2,0,$3,'old task','mobile',now()),($1,$4,0,$5,'retained task','mobile','2020-01-01')",[b,active,id(),active,id()]);
    const result=await c.query("SELECT prune_rank_tracking('2021-01-01','2021-01-01',100) result");assert.deepEqual(result.rows[0].result,{runs:1,tasks:1});
    assert.equal((await c.query("SELECT count(*)::int n FROM rank_check_runs WHERE id=$1",[old])).rows[0].n,0);
  });

  await group("aio_status", async (c) => {
    const b = await brand(c, "aio-status");
    const q1 = id(), q2 = id(), q3 = id();
    await c.query(
      "INSERT INTO workspace_questions(id, brand_key, text, topic, origin) VALUES ($1,$2,'q1','General','manual'), ($3,$2,'q2','General','manual'), ($4,$2,'q3','General','manual')",
      [q1, b, q2, q3]
    );

    const obs1 = id();
    await c.query(
      "INSERT INTO probe_observations(id, brand_key, job_id, query, engine, state, result) VALUES ($1,$2,'00000000-0000-0000-0000-000000000001','q1','aio','answered',$3::jsonb)",
      [obs1, b, JSON.stringify({ aio_present: true, brand_cited: true, brand_mentioned_in_text: true })]
    );
    await c.query(
      "INSERT INTO question_answer_links(brand_key, question_id, engine, observation_id, source, collected_at) VALUES ($1,$2,'aio',$3,'scan','2026-10-10T10:00:00Z')",
      [b, q1, obs1]
    );

    const obs2 = id();
    await c.query(
      "INSERT INTO probe_observations(id, brand_key, job_id, query, engine, state, result) VALUES ($1,$2,'00000000-0000-0000-0000-000000000001','q2','aio','valid_no_aio',$3::jsonb)",
      [obs2, b, JSON.stringify({ aio_present: false, brand_cited: false, brand_mentioned_in_text: false })]
    );
    await c.query(
      "INSERT INTO question_answer_links(brand_key, question_id, engine, observation_id, source, collected_at) VALUES ($1,$2,'aio',$3,'scan','2026-10-10T10:00:00Z')",
      [b, q2, obs2]
    );

    const pr3 = id();
    await c.query(
      "INSERT INTO prompt_results(id, brand, brand_key, query, engine, answered, brand_cited, mentioned) VALUES ($1,$2,$2,'q3','aio',true,false,true)",
      [pr3, b]
    );
    await c.query(
      "INSERT INTO question_answer_links(brand_key, question_id, engine, prompt_result_id, source, collected_at) VALUES ($1,$2,'aio',$3,'legacy','2026-10-09T10:00:00Z')",
      [b, q3, pr3]
    );

    const res = await c.query("SELECT * FROM rank_question_aio_status($1, $2::uuid[]) ORDER BY question_id", [b, [q1, q2, q3]]);
    assert.equal(res.rowCount, 3);
    const r1 = res.rows.find((r) => r.question_id === q1);
    assert.equal(r1.state, "answered");
    assert.equal(r1.own_cited, true);
    const r2 = res.rows.find((r) => r.question_id === q2);
    assert.equal(r2.state, "valid_no_aio");
    assert.equal(r2.aio_present, false);
    const r3 = res.rows.find((r) => r.question_id === q3);
    assert.equal(r3.state, "answered");
    assert.equal(r3.own_cited, false);
    assert.equal(r3.own_mentioned, true);

    await c.query("SAVEPOINT sp_aio");
    try {
      await c.query("DROP TABLE question_answer_links CASCADE");
      await assert.rejects(
        () => c.query("SELECT * FROM rank_question_aio_status($1, $2::uuid[])", [b, [q1]]),
        (err) => err.code === "42P01"
      );
    } finally {
      await c.query("ROLLBACK TO SAVEPOINT sp_aio");
    }
  });

  const expectedCount = onlyGroup ? 1 : 9;
  assert.equal(passed.length, expectedCount);
  console.log(`ok ${passed.length} group${passed.length === 1 ? "" : "s"}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "F15 DB check failed"); process.exitCode=1; }).finally(async () => { await pool.end(); });
