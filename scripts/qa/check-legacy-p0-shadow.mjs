#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const [root,input]=process.argv.slice(2),baseline='a2c97ddf12e332807c960e776eeae8de4550a210';
let networkAttempts=0;
const originalConsole={log:console.log,warn:console.warn,error:console.error};
try{
  assert.equal(root,'/tmp/aeovis-p0-legacy-shadow');
  for(const key of Object.keys(process.env))if(/SUPABASE|DATABASE|BRIGHTDATA|OPENAI|OPENROUTER|PERPLEXITY|GEMINI|^LLM_/.test(key))delete process.env[key];
  globalThis.fetch=async()=>{networkAttempts++;throw Error('Legacy shadow network is prohibited');};
  const sourcePath=`${root}/src/server/workers/scanWorker.js`,source=await fs.readFile(sourcePath);
  const expected=execFileSync('git',['show',`${baseline}:src/server/workers/scanWorker.js`]);
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),crypto.createHash('sha256').update(expected).digest('hex'));
  const data=JSON.parse(await fs.readFile(input,'utf8'));
  console.log=console.warn=console.error=()=>{};
  const {runFinalizePhase}=await import(pathToFileURL(sourcePath));
  const {makeMemoryScanBackend}=await import('../../src/server/demo/memoryScanBackend.js');
  const backend=makeMemoryScanBackend(),jobId=crypto.randomUUID();
  await backend.deps.upsertPromptResults(data.rows.map(row=>({...structuredClone(row),job_id:jobId,scan_id:null})));
  const old=await runFinalizePhase(jobId,structuredClone(data.checkpoint),{...backend.deps,resolveEnabledEngines:()=>data.checkpoint.engines.map(name=>({name})),extractCompetitors:async()=>[],getScansByDomain:async()=>[],getResultBrandsForScan:async()=>[]});
  assert.equal(old.status,'complete');assert.equal(networkAttempts,0);assert.notEqual(data.new_outcome.outcome,'complete');
  await fs.writeFile('docs/audits/2026-10-16/p0-legacy-shadow-evidence.json',JSON.stringify({suite:'archived-legacy-finalizer-shadow',executed_at:new Date().toISOString(),legacy_source_commit:baseline,legacy_worker_sha256:crypto.createHash('sha256').update(source).digest('hex'),source_job_id:data.source_job_id,provider_rows_replayed:data.rows.length,legacy_execution_status:old.status,legacy_collection_outcome:old.run_record?.summary_stats?.terminal_outcome?.outcome||null,new_collection_outcome:data.new_outcome.outcome,new_counts:data.new_outcome.counts,provider_requests:networkAttempts,production_writes:0,qualification:'Actual persisted owned-QA provider rows replayed through the verified archived baseline finalizer with all provider/database credentials removed, network prohibited and an isolated memory backend. Shadow fixture row links are local identities; original observations/results remain unchanged. This compares the legacy execution-complete contract with the new blocked collection result without duplicate paid requests.'},null,2)+'\n');
  originalConsole.log(JSON.stringify({legacy_status:old.status,new_collection_outcome:data.new_outcome.outcome,provider_requests:networkAttempts,production_writes:0}));
}catch(error){originalConsole.error(JSON.stringify({failed:true,error_type:error.name,code:error.code||null,module_path:error.code==='ERR_MODULE_NOT_FOUND'?/Cannot find module '([^']+)'/.exec(error.message)?.[1]||null:undefined}));process.exitCode=1;}
finally{Object.assign(console,originalConsole);}
