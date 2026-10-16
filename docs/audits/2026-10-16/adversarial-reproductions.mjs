// Offline audit reproductions. Uses synthetic answers and isolated memory only.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const arg=(name)=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const root=arg('--source-root');
if(!root) throw new Error('--source-root is required');
for(const key of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','DATABASE_URL','LLM_API_KEY','OPENROUTER_API_KEY','OPENAI_API_KEY','PERPLEXITY_API_KEY','BRIGHTDATA_API_KEY','GEMINI_API_KEY','SCAN_MAX_COST_PER_SCAN','SCAN_MAX_COST_PER_DAY']) delete process.env[key];
process.env.NEXT_PUBLIC_ENGINES='aio,chatgpt,gemini,perplexity';
globalThis.fetch=async()=>{throw new Error('OFFLINE AUDIT: network forbidden');};
const load=(relative)=>import(pathToFileURL(path.join(root,relative)).href);
const {summarizeEngineSlice,computeHeadline}=await load('src/lib/scoring/enginePipeline.js');
const {judgeBrandsSymmetric}=await load('src/lib/scoring/judge.js');
const {runScanChunk,runProbingPhase}=await load('src/lib/workers/scanWorker.js');
const {makeMemoryScanBackend}=await load('src/lib/demo/memoryScanBackend.js');
const {normalizeResult}=await load('src/services/api.js');
const {SAMPLE_RESULT}=await load('src/data/mockData.js');
const {computeContentLiftReport}=await load('src/lib/scoring/contentLift.js');
const report={audit_date:'2026-10-16',source_commit:'a2c97ddf12e332807c960e776eeae8de4550a210',network:'forbidden',checks:[]};
const add=(id,title,evidence)=>{report.checks.push({id,title,reproduced:true,evidence});console.log(`${id}: reproduced`);};
const row=(i,overrides={})=>({engine:'aio',prompt:`buyer question ${i}`,is_branded_query:false,answer_present:true,aio_present:true,text:'General category advice.',visible:false,brand_mentioned_in_text:false,brand_cited:false,references:[],citations:[],brands:[{name:'Acme',is_self:true,mentioned:false},{name:'Rival',is_self:false,mentioned:false}],error:null,...overrides});

const noOverview=summarizeEngineSlice(Array.from({length:30},(_,i)=>row(i,{answer_present:false,aio_present:false,text:''})),'aio');
assert.equal(noOverview.errored_queries,0);assert.equal(noOverview.state,'failed');
add('A01','30 successful SERPs without an AIO are classified as collection failure',{state:noOverview.state,reason:noOverview.state_reason,errors:noOverview.errored_queries});

const thinRows=Array.from({length:30},(_,i)=>row(i,i===0?{visible:true,brand_mentioned_in_text:true,text:'Acme is an option.',brands:[{name:'Acme',is_self:true,mentioned:true},{name:'Rival',is_self:false,mentioned:false}]}:{}));
const thin=summarizeEngineSlice(thinRows,'aio');
const thinHeadline=computeHeadline([thin]);
assert.equal(thin.eliciting_queries,1);assert.equal(thin.insufficient_sample,true);assert.equal(thinHeadline.visibility_index_pct,100);
add('A02','One eliciting answer can produce a 100% headline despite insufficient_sample',{answered:thin.non_branded_with_answer,eliciting:thin.eliciting_queries,insufficient_sample:thin.insufficient_sample,...thinHeadline});

const citationRows=Array.from({length:30},(_,i)=>row(i,i===0?{visible:true,brand_cited:true,text:'A useful category guide.',references:[{href:'https://acme.example/guide'}],citations:['https://acme.example/guide']}:{text:'Rival is an option.',brands:[{name:'Acme',is_self:true,mentioned:false},{name:'Rival',is_self:false,mentioned:true}]}));
const cited=summarizeEngineSlice(citationRows,'aio');
assert.equal(cited.cited_non_branded,1);assert.equal(cited.visible_non_branded,0);assert.equal(cited.share_of_ai_pct,0);
add('A03','A citation-only brand appearance is discarded from visibility by the eliciting filter',{cited:cited.cited_non_branded,visible:cited.visible_non_branded,score:cited.share_of_ai_pct});

const noRoster=Array.from({length:30},(_,i)=>row(i,{text:i<6?'Acme is an option.':'General category advice.',visible:i<6,brand_mentioned_in_text:i<6,brands:[{name:'Acme',is_self:true,mentioned:i<6}]}));
const withRoster=noRoster.map(r=>({...r,brands:[...r.brands,{name:'Rival',is_self:false,mentioned:false}]}));
const before=summarizeEngineSlice(noRoster,'aio'),after=summarizeEngineSlice(withRoster,'aio');
assert.equal(before.share_of_ai_pct,20);assert.equal(after.share_of_ai_pct,100);
add('A04','Changing roster metadata changes 20% to 100% with identical answers and self appearances',{before:before.share_of_ai_pct,after:after.share_of_ai_pct,unchanged_self_appearances:6,unchanged_answers:30});

const negative=judgeBrandsSymmetric('Avoid Acme. Rival is the best choice.',[{name:'Acme',isSelf:true,aliases:['Acme']},{name:'Rival',isSelf:false,aliases:['Rival']}]);
assert.equal(negative[0].mentioned,true);assert.equal(negative[0].position,1);
add('A05','First textual mention gives rank 1 even when that sentence rejects the brand',{answer:'Avoid Acme. Rival is the best choice.',judgment:negative});

const normalized=normalizeResult({...SAMPLE_RESULT,isSample:true});
assert.equal(normalized.isSample,undefined);assert.equal(normalized.enginesCounted,0);
add('A06','Normalizing a sample removes its sample marker and defaults counted engines to zero',{sample_marker_before:true,sample_marker_after:normalized.isSample??null,engines_counted:normalized.enginesCounted,score:normalized.visibilityScore,raw_rows:normalized.rawResults?.length});

const backend=makeMemoryScanBackend();
const job=await backend.deps.createScanJob({brand:'Acme',url:'https://acme.example',industry:'software',competitors:'Rival'});
const queries=Array.from({length:30},(_,i)=>({text:`best software option ${i+1}`,topic:'Software',source:'audit_fixture',intent_tier:'commercial',enabled:true}));
let attempts=0;
const engines=['aio','chatgpt','gemini','perplexity'].map(name=>({name,concurrency:6,probe:async(query)=>{attempts++;return row(0,{engine:name,prompt:query.text,answer_present:false,aio_present:false,text:'',error:'Synthetic transient provider timeout',error_kind:'transient',cost:0,brands:[]});}}));
const deps={...backend.deps,client:null,promptTarget:30,getScanSchedule:async()=>null,insertScanScheduleIfNotExists:async()=>({inserted:true}),getPromptsForBrand:async()=>queries,upsertPrompts:async()=>({}),buildBrandedQueries:()=>[],resolveEnabledEngines:()=>engines,getScansByDomain:async()=>[],getResultBrandsForScan:async()=>[],extractCompetitors:async()=>[{name:'Rival',source:'audit_fixture'}]};
for(let i=0;i<5&&!['complete','failed'].includes(job.status);i++)await runScanChunk(job.id,deps);
assert.equal(job.status,'complete');assert.equal(backend.promptResults.length,120);assert.equal(backend.promptResults.filter(r=>r.answered).length,0);
add('A07','A scan with 120 errors and zero answers still becomes complete',{status:job.status,persisted:backend.promptResults.length,answers:0,provider_attempts:attempts});
const attemptsBeforeResume=attempts;
await runProbingPhase(job.id,{brand:'Acme',url:'https://acme.example',competitors:['Rival'],queries,prompt_key:'acme.example',engines:engines.map(e=>e.name),stats:{cost:0}},deps);
assert.equal(attempts,attemptsBeforeResume);
add('A08','Resuming probing never retries persisted failed prompt-engine pairs',{persisted_failed_pairs:120,retries_on_resume:attempts-attemptsBeforeResume});

const lift=computeContentLiftReport({url:'https://acme.example/software'},[{prompt:'best software',related_content_url:'https://acme.example/software',visible:true,answer_present:true}],[{prompt:'best software',related_content_url:'https://acme.example/software',visible:false,answer_present:true}]);
assert.equal(lift.lift,null);
add('A09','Current visible/answered result rows cannot power the legacy prompt_score lift calculation',lift);

const offlineFetch=globalThis.fetch;
const {brightDataSearch,extractBrightDataAiOverview}=await load('src/lib/engines/brightdata.js');
process.env.BRIGHTDATA_API_KEY='EXAMPLE-NOT-A-REAL-KEY';
process.env.BRIGHTDATA_SERP_ZONE='audit-only';
globalThis.fetch=async()=>new Response(JSON.stringify({unexpected_shape:'not a valid Google result'}),{status:200,headers:{'content-type':'application/json'}});
const malformed=await brightDataSearch('audit query',{attempts:1,timeout:1000});
assert.equal(extractBrightDataAiOverview(malformed).text,'');
add('A10','The final malformed SERP payload is returned instead of raising a parse error',{returned_keys:Object.keys(malformed),extracted_overview:'',parse_error_raised:false});
delete process.env.BRIGHTDATA_API_KEY;delete process.env.BRIGHTDATA_SERP_ZONE;

process.env.LLM_API_KEY='sk-EXAMPLE-NOT-A-REAL-KEY';
process.env.LLM_BASE_URL='https://openrouter.ai/api/v1';
globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'Acme is an option.',annotations:[{type:'url_citation',url_citation:{url:'https://acme.example'}}]}}],usage:{prompt_tokens:10,completion_tokens:10,cost:0,server_tool_use:{web_search_requests:1}}}),{status:200,headers:{'content-type':'application/json'}});
const {probeChatGpt}=await load('src/lib/engines/openai.js');
const wrapped=await probeChatGpt('audit query');
assert.equal(wrapped.error,null);assert.equal(wrapped.model,undefined);assert.equal(wrapped.search_requests,undefined);
add('A11','The ChatGPT gateway wrapper discards model identity and web-search usage',{answered:!!wrapped.text,model_after_wrapper:wrapped.model??null,search_requests_after_wrapper:wrapped.search_requests??null});
delete process.env.LLM_API_KEY;delete process.env.LLM_BASE_URL;globalThis.fetch=offlineFetch;
const output=arg('--output');
if(output)await writeFile(output,JSON.stringify(report,null,2));
console.log(`Reproduced ${report.checks.length} audit cases with no network or production writes.`);
