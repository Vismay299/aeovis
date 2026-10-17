// Audit only. No provider calls, writes, migrations, or credential output.
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const runtimeRoot = arg('--runtime-root') || process.cwd();
const require = createRequire(path.join(runtimeRoot, 'package.json'));
const { Client } = require('pg');
const env = process.env;
const present = {};
for (const key of ['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_DB_HOST','SUPABASE_DB_PASSWORD','SUPABASE_SERVICE_ROLE_KEY','LLM_API_KEY','OPENROUTER_API_KEY','BRIGHTDATA_API_KEY','OPENAI_API_KEY','PERPLEXITY_API_KEY','CRON_SECRET','OPERATOR_TOKEN']) present[key] = Boolean(env[key]?.trim());
const output = { audit_date: '2026-10-16', checked_at_utc: new Date().toISOString(), local_credential_presence: present };
const queries = {
  tables: `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
  scans: `SELECT id,brand,url,scanned_at,prompts_tracked,prompts_mentioned,visibility_pct,raw_results->'engines' AS engines,raw_results->'summary_stats' AS summary_stats FROM public.scans ORDER BY created_at DESC LIMIT 12`,
  recent_jobs: `SELECT id,result_id,status,created_at,heartbeat_at,attempts,checkpoint->'engines' AS engines,checkpoint->'prompt_target' AS prompt_target,jsonb_array_length(checkpoint->'queries') AS checkpoint_queries,checkpoint->'geo' AS geo,CASE WHEN error_message IS NULL THEN NULL WHEN error_message ILIKE '%max_attempts%' THEN 'max_attempts' WHEN error_message ILIKE '%timeout%' THEN 'timeout' ELSE 'other_failure' END AS failure_category FROM public.scan_jobs ORDER BY created_at DESC LIMIT 20`,
  collection: `WITH recent AS (SELECT id FROM public.scans ORDER BY created_at DESC LIMIT 12) SELECT p.scan_id,p.engine,count(*)::int AS persisted_pairs,count(*) FILTER(WHERE NOT p.is_branded_query)::int AS unbranded_pairs,count(*) FILTER(WHERE p.answered AND p.raw->>'error' IS NULL)::int AS answered,count(*) FILTER(WHERE p.raw->>'error' IS NOT NULL)::int AS errors,count(*) FILTER(WHERE NOT p.answered AND p.raw->>'error' IS NULL)::int AS no_answer,min(p.created_at) AS first_result_at,max(p.created_at) AS last_result_at FROM public.prompt_results p JOIN recent r ON p.scan_id=r.id GROUP BY p.scan_id,p.engine ORDER BY p.scan_id,p.engine`,
  failure_categories: `SELECT engine,CASE WHEN raw->>'error' ILIKE '%HTTP 401%' THEN 'credential_rejected' WHEN raw->>'error' ILIKE '%key limit exceeded%' THEN 'key_spend_limit' WHEN raw->>'error' ILIKE '%HTTP 403%' THEN 'access_denied' WHEN raw->>'error' ILIKE '%no ready cookies%' THEN 'cookie_pool_unavailable' WHEN raw->>'error' ILIKE '%timeout%' OR raw->>'error' ILIKE '%abort%' THEN 'timeout_or_abort' WHEN raw->>'error' ILIKE '%HTTP 429%' THEN 'rate_limited' WHEN raw->>'error' ILIKE '%HTTP 404%' THEN 'model_or_endpoint_not_found' ELSE 'other_provider_error' END AS category,count(*)::int AS pairs FROM public.prompt_results WHERE created_at > now()-interval '30 days' AND raw->>'error' IS NOT NULL GROUP BY engine,category ORDER BY engine,pairs DESC`,
  latest_job_matrix: `WITH jobs AS (SELECT id,status,checkpoint FROM public.scan_jobs WHERE checkpoint IS NOT NULL ORDER BY created_at DESC LIMIT 8), expected AS (SELECT j.id,j.status,e.engine,q.query->>'text' AS query FROM jobs j CROSS JOIN LATERAL jsonb_array_elements_text(j.checkpoint->'engines') AS e(engine) CROSS JOIN LATERAL jsonb_array_elements(j.checkpoint->'queries') AS q(query)) SELECT e.id,e.status,e.engine,count(*)::int AS expected,count(p.id)::int AS persisted,count(*) FILTER(WHERE p.id IS NULL)::int AS never_persisted,count(*) FILTER(WHERE p.raw->>'error' IS NOT NULL)::int AS failed,count(*) FILTER(WHERE p.answered AND p.raw->>'error' IS NULL)::int AS answered FROM expected e LEFT JOIN public.prompt_results p ON p.job_id=e.id AND p.engine=e.engine AND p.query=e.query GROUP BY e.id,e.status,e.engine ORDER BY e.id,e.engine`,
  schedules: `SELECT enabled,count(*)::int AS schedules FROM public.scan_schedules GROUP BY enabled`,
  jobs_by_state: `SELECT status,count(*)::int AS jobs,count(*) FILTER(WHERE heartbeat_at<now()-interval '1 day')::int AS heartbeat_older_than_day FROM public.scan_jobs GROUP BY status`,
  content_jobs_by_state: `SELECT status,count(*)::int AS jobs,count(*) FILTER(WHERE heartbeat_at<now()-interval '1 day')::int AS heartbeat_older_than_day FROM public.content_jobs GROUP BY status`,
  policy_summary: `SELECT tablename,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`,
  normalized_coverage: `SELECT (SELECT count(*) FROM public.prompt_results)::int AS prompt_results,(SELECT count(*) FROM public.citations)::int AS citations,(SELECT count(*) FROM public.result_brands)::int AS result_brands,(SELECT count(*) FROM public.brand_metrics_daily)::int AS daily_metrics`,
  execution_ledger: `SELECT runner,phase,outcome,reason,count(*)::int AS runs,sum(probes_attempted)::int AS attempted,sum(probes_succeeded)::int AS succeeded FROM public.scan_runs WHERE started_at>now()-interval '7 days' GROUP BY runner,phase,outcome,reason ORDER BY runs DESC LIMIT 30`,
  latest_collection_details: `WITH latest AS(SELECT id FROM public.scans ORDER BY created_at DESC LIMIT 1) SELECT p.engine,p.is_branded_query,count(*)::int AS recorded,count(*) FILTER(WHERE p.answered AND p.raw->>'error' IS NULL)::int AS answered,count(*) FILTER(WHERE NOT p.answered AND p.raw->>'error' IS NULL)::int AS no_answer,CASE WHEN p.raw->>'error' IS NULL THEN 'no_error' WHEN p.raw->>'error' ILIKE '%HTTP 401%' THEN 'credential_rejected' WHEN p.raw->>'error' ILIKE '%key limit exceeded%' THEN 'key_spend_limit' WHEN p.raw->>'error' ILIKE '%no ready cookies%' THEN 'cookie_pool_unavailable' ELSE 'other_error' END AS category FROM public.prompt_results p JOIN latest l ON l.id=p.scan_id GROUP BY p.engine,p.is_branded_query,category ORDER BY p.engine,p.is_branded_query,category`,
  latest_surface_evidence: `WITH recent AS(SELECT id FROM public.scans ORDER BY created_at DESC LIMIT 5) SELECT p.engine,p.raw->>'measurement_method' AS method,p.raw->>'model_used' AS model,count(*)::int AS pairs,count(*) FILTER(WHERE p.raw->>'search_requests' IS NOT NULL)::int AS search_telemetry_present,count(*) FILTER(WHERE (p.raw->>'search_requests')~'^[0-9]+$' AND (p.raw->>'search_requests')::int>0)::int AS search_used,count(*) FILTER(WHERE p.evidence_screenshot_id IS NOT NULL)::int AS screenshot_evidence FROM public.prompt_results p JOIN recent r ON p.scan_id=r.id GROUP BY p.engine,method,model ORDER BY p.engine,pairs DESC`,
  latest_query_sample: `WITH latest AS(SELECT id FROM public.scans ORDER BY created_at DESC LIMIT 1) SELECT p.query,p.raw->>'topic' AS topic,p.raw->>'source' AS source,p.intent,length(p.answer_text) AS answer_characters,p.answered,p.mentioned,p.brand_cited FROM public.prompt_results p JOIN latest l ON l.id=p.scan_id WHERE p.engine='aio' AND NOT p.is_branded_query ORDER BY p.created_at LIMIT 15`,
  content_outcomes: `SELECT status,count(*)::int AS items FROM public.content_items GROUP BY status`,
  gsc_status: `SELECT (SELECT count(*) FROM public.gsc_connections)::int AS connections,(SELECT count(*) FROM public.gsc_daily)::int AS daily_rows,(SELECT max(date) FROM public.gsc_daily) AS latest_date`,
  rls_status: `SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relkind='r' ORDER BY relname`,
};
let client;
try {
  if (!env.SUPABASE_DB_HOST || !env.SUPABASE_DB_PASSWORD || !env.NEXT_PUBLIC_SUPABASE_URL) throw Object.assign(new Error(), {code:'DB_CONFIG_MISSING'});
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
  client = new Client({host:env.SUPABASE_DB_HOST,port:Number(env.SUPABASE_DB_PORT||5432),user:env.SUPABASE_DB_USER||`postgres.${ref}`,password:env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,statement_timeout:12000});
  await client.connect();
  const selectedSections = arg('--sections')?.split(',');
  for (const [name, sql] of Object.entries(queries).filter(([name])=>!selectedSections||selectedSections.includes(name))) {
    await client.query('BEGIN READ ONLY');
    try { output[name]=(await client.query(sql)).rows; }
    catch(error) { output[name]={unavailable:true,code:error.code||'UNKNOWN'}; }
    finally { await client.query('ROLLBACK'); }
  }
} catch(error) { output.database_audit={unavailable:true,code:error.code||'UNKNOWN'}; }
finally { await client?.end().catch(()=>{}); }
try {
  const response=await fetch('https://aeo-vis.vercel.app/api/health',{signal:AbortSignal.timeout(20000)});
  output.production_health={http_status:response.status,payload:await response.json()};
} catch { output.production_health={unavailable:true}; }
const destination=arg('--output');
if(destination) { await writeFile(destination,JSON.stringify(output,null,2)); console.log(`Audit evidence written to ${destination}`); }
else console.log(JSON.stringify(output,null,2));
