import test from 'node:test';
import assert from 'node:assert/strict';
import {createMetric,measurementContext} from '../scoring/metricContract.js';
import {qualifyVisibilityPoint,computeQualifiedVisibilitySummary,comparableVisibilityTail} from './visibilitySeries.js';
const context=measurementContext({panelVersion:'fixed-questions',surfaceVersion:'model-api',market:'in',modelPolicyVersion:'models-v1',engineCohort:['chatgpt']});
const metric=(mentions=6,n=30,ctx=context)=>createMetric({metricId:'observed_exposure',numerator:mentions,denominator:n,eligiblePromptIds:Array.from({length:n},(_,i)=>`q-${i}`),collection:{valid:n,planned:n},context:ctx});
const point=(m,date='2026-10-20',stored=m.qualified_pct)=>({date,engine:'all',...qualifyVisibilityPoint({engine:'all',visibility_pct:stored},{headline_metric:m})});

test('R05-24 daily trend retains the exact stored metric DTO and measured zero',()=>{
  const m=metric(0),p=point(m);assert.equal(p.visibility_pct,0);const {eligible_prompt_ids,...context}=m;assert.deepEqual(p.metric,context);assert.equal(eligible_prompt_ids.length,30);assert.equal('eligible_prompt_ids' in p.metric,false);assert.equal(p.metric_state,'measured_zero');
  const perEngine=qualifyVisibilityPoint({engine:'chatgpt',visibility_pct:0},{headline_metric:m});assert.equal(perEngine.visibility_pct,0);
});
test('R05-22 daily trend does not promote an insufficient 100 percent to a headline',()=>{
  const m=metric(5,5),p=point(m,undefined,100);assert.equal(m.value_pct,100);assert.equal(p.visibility_pct,null);assert.equal(p.stored_visibility_pct,100);assert.equal(p.metric.qualified,false);
  assert.equal(computeQualifiedVisibilitySummary([point(metric()),p]).delta_visibility_pct,null);
});
test('R05-20 legacy daily scalar is retained as historical data without inventing qualification or context',()=>{
  const p=qualifyVisibilityPoint({engine:'all',visibility_pct:80},null);assert.equal(p.visibility_pct,null);assert.equal(p.stored_visibility_pct,80);assert.equal(p.metric_state,'legacy_unknown');assert.equal(p.metric,null);
  assert.equal(computeQualifiedVisibilitySummary([p,p]).delta_visibility_pct,null);
});
test('R05-18 daily deltas refuse every changed measurement dimension',()=>{
  const earlier=point(metric(6),'2026-10-19');
  for(const [key,value] of Object.entries({panel_version:'different-panel',surface_version:'consumer-browser',market:'us',model_policy_version:'models-v2',metric_version:'new-contract',policy_version:'new-policy',engine_cohort:'aio,chatgpt'})){
    const later=point(metric(12,30,{...context,[key]:value}));const summary=computeQualifiedVisibilitySummary([earlier,later]);assert.equal(summary.delta_visibility_pct,null,key);assert.equal(summary.comparison.comparable,false,key);assert.ok(summary.comparison.changed.some(c=>c.dimension===key),key);
  }
});
test('R05-18 compatible qualified daily readings retain a real positive or zero delta',()=>{
  const earlier=point(metric(6),'2026-10-19'),later=point(metric(12));assert.equal(computeQualifiedVisibilitySummary([earlier,later]).delta_visibility_pct,20);assert.equal(computeQualifiedVisibilitySummary([later,later]).delta_visibility_pct,0);
});
test('R05-21 contradictory rollup or source metadata is flagged and withheld',()=>{
  const m=metric(6),p=point(m,undefined,99);assert.equal(p.visibility_pct,null);assert.equal(p.metric_state,'contradictory');assert.ok(p.contradictions.some(c=>c.code==='daily_projection_mismatch'));assert.equal(computeQualifiedVisibilitySummary([point(m),p]).delta_visibility_pct,null);
  assert.equal(point({...m,numerator:31}).visibility_pct,null);
  assert.equal(point({...m,qualified:false,qualified_pct:20}).visibility_pct,null);
});
test('R05-24 a blended headline cannot be substituted for a missing engine metric',()=>{
  const m=metric(6,30,{...context,engine_cohort:'aio,chatgpt'});assert.equal(qualifyVisibilityPoint({engine:'aio',visibility_pct:20},{headline_metric:m}).visibility_pct,null);
});
test('R05-18 trend and hover deltas cannot bridge a version boundary or unknown point',()=>{
  const old=point(metric(6,30,{...context,market:'us'}),'2026-10-17');
  const a=point(metric(9),'2026-10-18'),b=point(metric(12),'2026-10-19');
  assert.deepEqual(comparableVisibilityTail([old,a,b]),[a,b]);
  assert.deepEqual(comparableVisibilityTail([a,{visibility_pct:null,metric:null},b]),[b]);
  assert.deepEqual(comparableVisibilityTail([a,{visibility_pct:null,metric:null}]),[]);
});

test('R05-24 a withheld reading explains its own qualification reason, not a context change',()=>{
  const thin=point(metric(5,5),'2026-10-21',100),summary=computeQualifiedVisibilitySummary([point(metric(),'2026-10-20'),thin]);
  assert.equal(summary.delta_visibility_pct,null);assert.equal(summary.comparison.comparable,false);
  assert.equal(summary.comparison.boundary_reason,thin.metric_reason);assert.match(summary.comparison.detail,/^The latest reading is withheld: /);assert.doesNotMatch(summary.comparison.detail,/context/i);
  const legacy=computeQualifiedVisibilitySummary([qualifyVisibilityPoint({engine:'all',visibility_pct:40},null),point(metric())]);
  assert.match(legacy.comparison.detail,/previous reading is historical/);
});
