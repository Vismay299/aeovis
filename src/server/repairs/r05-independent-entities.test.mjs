import test from "node:test";
import assert from "node:assert/strict";
import { resolveEntityEvidence, applyEntityEvidence } from "../../shared/scoring/entityEvidence.js";
import { probeTextEngine, summarizeEngineSlice, computeHeadline } from "../../shared/scoring/enginePipeline.js";
import { getBrandAliases } from "../../shared/scoring/aliases.js";
import { METRIC_IDS } from "../../shared/scoring/metricContract.js";
import { checkComparability } from "../../shared/scoring/metricContract.js";

test("R05-02/R05-03: actual probe self evidence is independent of rival selection, including overlapping names", async () => {
  const observed=[];
  for(const rivals of [[],["Acme", "Acme Cloud", "Unmentioned"],["Acme Cloud"]]) {
    const row=await probeTextEngine({name:"chatgpt",probe:async()=>({text:"Acme Analytics is an option. Acme Cloud is separate.",references:[{href:"https://docs.acme.example/guide"}],cost:0})}, {text:"Which analytics options exist?"}, "Acme Analytics", getBrandAliases("Acme Analytics","https://acme.example"), "acme.example", rivals, {});
    observed.push({mention:row.brand_mentioned_in_text,cited:row.brand_cited,evidence:row.entity_evidence});
  }
  assert.deepEqual(observed[0],observed[1]);assert.deepEqual(observed[0],observed[2]);
  assert.equal(observed[0].mention,true);assert.equal(observed[0].cited,true);
});

test("R05-04: citation-only evidence and lookalike hosts do not become textual mentions", () => {
  const own=resolveEntityEvidence({brand:"Acme",website:"https://acme.example",text:"A general answer.",references:[{href:"https://docs.acme.example/a"}]});
  assert.equal(own.mentioned,false);assert.equal(own.cited,true);
  const foreign=resolveEntityEvidence({brand:"Acme Analytics",website:"https://acme.example",text:"https://acme.example.attacker.example is unrelated",references:[{href:"https://notacme.example",domain:"acme.example"},{href:"javascript:alert(1)"}]});
  assert.equal(foreign.mentioned,false);assert.equal(foreign.cited,false);
});

test("R05-05: generic alias uncertainty cannot become a qualified zero or be laundered through headline pooling", () => {
  const rows=Array.from({length:30},(_,i)=>applyEntityEvidence({engine:"chatgpt",prompt:`question-${i}`,answer_present:true,text:i?"The Box platform is discussed.":"Put the receipt in a box.",references:[],brands:[],error:null}, {brand:"Box",website:"https://box.example"}));
  const slice=summarizeEngineSlice(rows,"chatgpt");
  assert.equal(rows[0].entity_evidence.mention_state,"ambiguous");
  assert.equal(rows[0].brand_mentioned_in_text,null);
  assert.equal(slice.metrics[METRIC_IDS.MENTION].qualified_pct,null);
  assert.equal(slice.metrics[METRIC_IDS.EXPOSURE].qualified_reason,"entity_resolution_incomplete");
  assert.equal(computeHeadline([slice]).headline_pct,null);
});

test("R05-01: echoed question masking retains exact evidence offsets and observed domains", () => {
  const text='Question: "Should Acme be selected?"\nThe answer recommends Acme.';
  const r=resolveEntityEvidence({brand:"Acme",website:"https://acme.example",text});
  assert.ok(r.spans.length);
  for(const s of r.spans){assert.equal(text.slice(s.start,s.end),s.text);assert.ok(s.start>text.indexOf("\n"));}
  assert.equal(resolveEntityEvidence({brand:"Box",website:"https://box.example",text:"Read https://box.example/docs"}).mentioned,true);
});

test("R05-18: entity policy changes create a headline comparison boundary and mixed labels withhold qualification",()=>{
  const options={panelVersion:"panel-a",surfaceVersion:"api-v1",market:"in",modelPolicyVersion:"model-a"};
  const fresh=Array.from({length:30},(_,i)=>applyEntityEvidence({engine:"chatgpt",prompt:`question-${i}`,answer_present:true,text:"Acme is available.",references:[],brands:[],error:null},{brand:"Acme",website:"https://acme.example"}));
  const legacy=fresh.map(({entity_evidence,...r})=>r);
  const newer=computeHeadline([summarizeEngineSlice(fresh,"chatgpt",options)],undefined,options).headline_metric;
  const older=computeHeadline([summarizeEngineSlice(legacy,"chatgpt",options)],undefined,options).headline_metric;
  assert.equal(checkComparability(newer,older).comparable,false);
  const mixed=summarizeEngineSlice([...fresh.slice(0,15),...legacy.slice(15)],"chatgpt",options);
  assert.equal(computeHeadline([mixed],undefined,options).headline_pct,null);
});
