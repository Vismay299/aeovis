#!/usr/bin/env node
// Explicit, bounded owned-workspace rollout. Preserves real paid history.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {chromium} from '../../worker/node_modules/playwright/index.mjs';
const [origin,fixturePath,cookiePath]=process.argv.slice(2);
let browser,db,fixture,jobId,stage='input',rollbackAt;
const log=()=>console.log(JSON.stringify({stage,job_id:jobId||null}));
try{
  assert.match(new URL(origin).hostname,/^aeo-[a-z0-9]+-vismays-projects-e0c6f290\.vercel\.app$/);
  fixture=JSON.parse(await fs.readFile(fixturePath,'utf8'));
  assert.equal(fixture.users.length,2);
  const keys=fixture.users.map((u,i)=>{const expected=`qa-p0-${fixture.run_id}-${i?'b':'a'}.example`;assert.equal(u.brand_key,expected);return expected;});
  const ref=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
  db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-1-ap-southeast-2.pooler.supabase.com',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,statement_timeout:10000});
  await db.connect();
  const owned=(await db.query("select id from auth.users where id=any($1::uuid[]) and raw_user_meta_data->>'p0_qualification_run'=$2",[fixture.users.map(u=>u.id),fixture.run_id])).rows;
  assert.equal(owned.length,2);
  const control=(await db.query('select * from probe_dispatch_control where singleton=true')).rows[0];
  assert.equal(control.paused,true);assert.deepEqual(control.brand_allowlist,[keys[0]]);
  const historical=async()=>{
    const result={};for(const table of ['scans','scan_jobs'])result[table]=(await db.query(`select count(*)::int as count,md5(coalesce(string_agg(id::text||md5(to_jsonb(t)::text),'|' order by id),'')) as digest from ${table} t where brand_key is null or not(brand_key=any($1::text[]))`,[keys])).rows[0];return result;
  };
  const before=await historical();
  // No recurrence; exactly the approved question and these four offered engines.
  await db.query("insert into scan_schedules(brand,display_name,cadence,enabled,prompt_target,engines,geo) values($1,'P0 bounded rollback','off',false,10,'aio,chatgpt,gemini,perplexity','in')",[keys[0]]);
  const cookies=(await fs.readFile(cookiePath,'utf8')).split('\n').flatMap(line=>{const httpOnly=line.startsWith('#HttpOnly_');if(httpOnly)line=line.slice(10);if(!line||line.startsWith('#'))return [];const [domain,,path,secure,expires,name,value]=line.split('\t');return name&&value?[{domain,path,secure:secure==='TRUE',expires:Number(expires)||-1,name,value,httpOnly,sameSite:'None'}]:[];});
  browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.addCookies(cookies);const page=await context.newPage();
  let authStatus;
  await page.route('**/auth/v1/token?grant_type=password',async route=>{try{const response=await route.fetch();authStatus=response.status();await response.body();await route.fulfill({response});}catch{authStatus=0;await route.abort();}});
  stage='owned customer login';log();await page.goto(`${origin}/login?next=${encodeURIComponent('/portal/measurement')}`);await page.getByLabel('Work email').fill(fixture.users[0].email);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Questions and evidence',exact:true}).waitFor({timeout:45000});assert.equal(authStatus,200);
  const post=async(path,data)=>{const r=await context.request.post(`${origin}${path}`,{headers:{origin},data,timeout:30000});assert.equal(r.status(),201);return r.json();};
  stage='approve one frozen QA question';log();
  await post(`/api/customer/repairs/panel?brand_key=${encodeURIComponent(keys[0])}`,{key:'default',expected_version:0,state:'approved',payload:{persona:'Authorized QA small-business buyers; one-question rollout, insufficient for a headline',context:{country:'in',language:'en',device:'desktop',session_policy:'fresh_anonymous'},prompts:[{text:'What factors should a small business consider when choosing accounting software?',purpose:'information',origin:'manual',weight:1}]}});
  stage='start owned customer scan';log();
  const started=await post('/api/customer/scan',{brand_key:keys[0],industry:'QA rollback qualification'});jobId=started.job_id;assert.ok(jobId);
  await fs.writeFile('/tmp/aeovis-p0-deploy/owned-rollout-job.json',JSON.stringify({job_id:jobId,run_id:fixture.run_id,brand_key:keys[0]}),{mode:0o600});
  const deadline=Date.now()+10*60_000;
  stage='wait for actual ChatGPT lease';log();
  let inFlight;
  while(Date.now()<deadline){
    const rows=(await db.query("select id,engine,state,lease_token from probe_observations where job_id=$1",[jobId])).rows;
    inFlight=rows.find(r=>r.engine==='chatgpt'&&r.state==='leased');if(inFlight)break;
    const status=(await db.query('select status from scan_jobs where id=$1',[jobId])).rows[0]?.status;
    if(['complete','failed'].includes(status))throw Object.assign(Error('No in-flight rollback barrier observed'),{code:'qa_missing_lease_barrier'});
    await new Promise(r=>setTimeout(r,200));
  }
  assert.ok(inFlight);
  stage='rollback owned claims while real request is in flight';log();
  await db.query("select set_probe_rollout(true,true,'{}'::text[])");
  rollbackAt=(await db.query('select clock_timestamp() as at')).rows[0].at;
  let job;
  stage='wait for durable completion after rollback';log();
  while(Date.now()<deadline){job=(await db.query('select status,result_id,run_record from scan_jobs where id=$1',[jobId])).rows[0];if(['complete','failed'].includes(job.status))break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(job.status,'complete');assert.ok(job.result_id);
  const observations=(await db.query('select id,engine,state,attempt_count,reason from probe_observations where job_id=$1 order by engine',[jobId])).rows;
  assert.equal(observations.length,4);assert.equal(observations.find(o=>o.id===inFlight.id).state,'answered');
  const later=(await db.query('select count(*)::int n from probe_attempts a join probe_observations o on o.id=a.observation_id where o.job_id=$1 and a.started_at>$2',[jobId,rollbackAt])).rows[0].n;assert.equal(later,0);
  const attempt=(await db.query('select dispatch_state,finished_at from probe_attempts where observation_id=$1 and lease_token=$2',[inFlight.id,inFlight.lease_token])).rows[0];assert.equal(attempt.dispatch_state,'recorded');assert.ok(attempt.finished_at);
  const response=await context.request.get(`${origin}/api/customer/scan/report/${job.result_id}`);assert.equal(response.status(),200);const report=await response.json();
  const outcome=report.scan.summary_stats.terminal_outcome;assert.equal(outcome.counts.planned,4);assert.equal(outcome.equation.holds,true);assert.notEqual(outcome.outcome,'complete');assert.equal(report.scan.summary_stats.headline_metric.qualified_pct,null);
  const after=await historical();assert.deepEqual(after,before);
  const finalControl=(await db.query('select paused,canaries_allowed,brand_allowlist from probe_dispatch_control')).rows[0];assert.equal(finalControl.paused,true);assert.deepEqual(finalControl.brand_allowlist,[]);
  await fs.writeFile('docs/audits/2026-10-16/p0-owned-rollout-evidence.json',JSON.stringify({suite:'actual-owned-customer-worker-rollback',executed_at:new Date().toISOString(),deployment:origin,run_id:fixture.run_id,job_id:jobId,scan_id:job.result_id,approved_scoring_questions:1,offered_engines:4,rollback_at:rollbackAt,observations,terminal_outcome:outcome,legacy_execution_status:job.status,qualified_headline:report.scan.summary_stats.headline_metric.qualified_pct,inflight_result_recorded:true,post_rollback_dispatches:later,historical_records_unchanged:true,dispatch_control:finalControl,qualification:'Actual customer login, approved question panel, deployed worker, durable claims and real provider calls. Rollback removed only the owned QA allowlist while the request was in flight. Historical customer records and all paid QA attempts/captures are retained. The one-question panel deliberately cannot qualify a headline. QA Auth users/workspaces and disabled schedule are retained for evidence, not represented as deleted fixtures.'},null,2)+'\n');
  stage='rollout and in-flight rollback passed';log();
}catch(error){console.error(JSON.stringify({failed:true,stage,code:error.code||error.name,job_id:jobId||null}));process.exitCode=1;}
finally{
  if(db){try{if(fixture){const c=(await db.query('select brand_allowlist from probe_dispatch_control')).rows[0];if(c.brand_allowlist.includes(fixture.users[0].brand_key))await db.query("select set_probe_rollout(true,true,'{}'::text[])");}}catch{console.error('Owned rollout pause could not be confirmed.');}await db.end();}
  if(browser)await browser.close();
}
