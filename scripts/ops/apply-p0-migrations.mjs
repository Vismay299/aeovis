#!/usr/bin/env node
// Deliberate 027–035 rollout. Default is a read-only, hash-bound plan. Never
// reapply old migrations or use a missing table's SELECT result as verification.
import pg from "pg";
import {readFile,writeFile,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {checksumsFor} from "../setup-supabase.mjs";

const [mode,manifestPath]=process.argv.slice(2);
if(!["--plan","--apply"].includes(mode) || !manifestPath)throw Error("Use --plan FILE or --apply FILE");
const ref=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||"aws-1-ap-southeast-2.pooler.supabase.com",port:Number(process.env.SUPABASE_DB_PORT||5432),user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,database:"postgres",ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,statement_timeout:60000});
const names=(await readdir("supabase/migrations")).filter(f=>/^(02[789]|03[0-5])_.*\.sql$/.test(f)).sort();
if(names.length!==9)throw Error("Exact P0 migration set required");
const files=await Promise.all(names.map(async name=>({name,sql:await readFile(`supabase/migrations/${name}`,"utf8")})));
const source=Object.fromEntries(files.map(f=>[f.name,checksumsFor(f.sql)]));
const planHash=createHash("sha256").update(JSON.stringify({ref,source})).digest("hex");
const manifest={project_ref:ref,plan_hash:planHash,source,executed_at:new Date().toISOString()};
try{
  await client.connect();
  await client.query(mode==="--plan"?"BEGIN READ ONLY":"BEGIN");
  if(mode==="--apply"){
    const prepared=JSON.parse(await readFile(manifestPath,"utf8"));
    if(prepared.plan_hash!==planHash || prepared.project_ref!==ref)throw Error("Prepared migration plan changed; run read-only planning again");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aeovis-p0-rollout'))");
    await client.query("LOCK TABLE scan_jobs IN SHARE ROW EXCLUSIVE MODE");
  }
  const applied=(await client.query("select filename,checksum from schema_migrations order by filename")).rows;
  if(!applied.some(r=>r.filename==="026_customer_uat_repairs.sql"))throw Error("Required 026 baseline absent");
  const active=Number((await client.query("select count(*) n from scan_jobs where status not in ('complete','failed')")).rows[0].n);
  if(active)throw Error("Active scan jobs must drain before migration");
  manifest.active_jobs=active;
  manifest.before_counts=(await client.query("select (select count(*) from scans)::int scans,(select count(*) from scan_jobs)::int jobs,(select count(*) from prompt_results)::int results")).rows[0];
  manifest.pending=files.filter(f=>!applied.some(r=>r.filename===f.name)).map(f=>f.name);
  for(const f of files){const prior=applied.find(r=>r.filename===f.name);if(prior && prior.checksum!==source[f.name].checksum)throw Error("Previously applied P0 migration checksum differs");}
  if(mode==="--apply"){
    for(const f of files.filter(f=>manifest.pending.includes(f.name))){
      await client.query(f.sql);
      await client.query("insert into schema_migrations(filename,checksum,sql_checksum,applied_at,first_applied_at) values($1,$2,$3,now(),now())",[f.name,source[f.name].checksum,source[f.name].sqlChecksum]);
    }
    for(const table of ["probe_observations","probe_attempts","probe_dispatch_control","measurement_evidence","repair_artifacts","content_check_claims","measurement_windows"]){
      const exists=(await client.query("select to_regclass($1) present",[`public.${table}`])).rows[0].present;
      if(!exists)throw Error("Migration catalog verification failed");
    }
    for(const name of ["claim_probe_dispatch","materialize_scan_report","record_measurement_incident","enqueue_measurement_window"]){
      const exists=(await client.query("select exists(select 1 from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname=$1) present",[name])).rows[0].present;
      if(!exists)throw Error("Required function missing from catalog");
    }
    // Hold ordinary dispatch while explicit QA qualification/rollout is prepared.
    await client.query("update probe_dispatch_control set paused=true where singleton=true");
    manifest.after_counts=(await client.query("select (select count(*) from scans)::int scans,(select count(*) from scan_jobs)::int jobs,(select count(*) from prompt_results)::int results")).rows[0];
    if(JSON.stringify(manifest.before_counts)!==JSON.stringify(manifest.after_counts))throw Error("Unexpected historical row count change");
    manifest.dispatch_paused=true;
    await client.query("COMMIT");
  }else await client.query("ROLLBACK");
  manifest.applied=mode==="--apply";
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify({applied:manifest.applied,pending:manifest.pending,active_jobs:active,history_counts_preserved:mode==="--apply",dispatch_paused:manifest.dispatch_paused||false}));
}catch(e){await client.query("ROLLBACK").catch(()=>{console.error("Migration rollback could not be confirmed");});console.error(JSON.stringify({migration_failed:true,error:e.code||e.name,reason:/plan|baseline|Active|checksum|catalog|function|count/.test(e.message)?e.message:"Database operation failed; no credentials logged"}));process.exitCode=1;}finally{await client.end();}
