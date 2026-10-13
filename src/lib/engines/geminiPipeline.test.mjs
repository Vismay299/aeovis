import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnabledEngines, summarizeEngineSlice, computeHeadline } from "../scoring/enginePipeline.js";
import { parseEngineParam } from "../brandAnalyticsApi.js";
import { parseEngineList } from "./deployedEngines.js";

test("Gemini uses configured grounded model and its answers/citations reach scan scoring and analytics", async(t)=>{
  const names=["LLM_API_KEY","LLM_BASE_URL","OPENROUTER_GEMINI_MODEL"];
  const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  t.after(()=>{for(const name of names) if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];});
  process.env.LLM_API_KEY="test";process.env.LLM_BASE_URL="https://openrouter.ai/api/v1";process.env.OPENROUTER_GEMINI_MODEL="google/gemini-test";
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    const body=JSON.parse(init.body);
    assert.equal(body.model,"google/gemini-test");
    assert.equal(body.tools[0].type,"openrouter:web_search");
    assert.deepEqual(body.reasoning,{effort:"minimal"});
    return {ok:true,json:async()=>({choices:[{message:{content:"Italica is a tile brand.",annotations:[{type:"url_citation",url:"https://italicatiles.com/",title:"Italica"}]}}],usage:{cost:0.001,total_tokens:20}})};
  });
  const [engine]=resolveEnabledEngines({engines:"gemini"});
  assert.equal(engine.name,"gemini");
  const result=await engine.probe({text:"best tile brands in India",topic:"Tiles"},"Italica",["Italica"],"italicatiles.com",[],{});
  assert.equal(result.answer_present,true);assert.equal(result.visible,true);assert.equal(result.brand_cited,true);assert.equal(result.references.length,1);
  const rows=Array.from({length:10},(_,i)=>({...result,prompt:`best tile supplier ${i}`}));
  const summaries={gemini:summarizeEngineSlice(rows,"gemini")};
  assert.equal(summaries.gemini.share_of_ai_pct,100);
  assert.equal(computeHeadline(Object.values(summaries)).engines_counted,1);
  assert.deepEqual(parseEngineParam("gemini"),{engine:"gemini",error:null});
  assert.ok(parseEngineList("aio,chatgpt,gemini,perplexity").includes("gemini"));
});


test("empty gateway responses are retried and their actual costs remain counted",async(t)=>{
  const names=["LLM_API_KEY","LLM_BASE_URL"];
  const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  t.after(()=>{for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];});
  process.env.LLM_API_KEY="test";process.env.LLM_BASE_URL="https://openrouter.ai/api/v1";
  let attempts=0;
  t.mock.method(globalThis,"fetch",async()=>({ok:true,json:async()=>({choices:[{finish_reason:++attempts===1?"length":"stop",message:{content:attempts===1?"":"A final answer"}}],usage:{cost:0.001,total_tokens:20}})}));
  const {probeOpenRouterEngine}=await import("./openRouterProbe.js");
  const stats={};
  const result=await probeOpenRouterEngine({engine:"chatgpt",query:"best tile brands",stats});
  assert.equal(attempts,2);assert.equal(result.text,"A final answer");assert.equal(result.error,null);
  assert.equal(stats.cost,0.002);
});
