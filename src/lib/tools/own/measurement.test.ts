import test from "node:test";
import assert from "node:assert/strict";
import { createMeasurementStatusTool } from "./measurement.ts";
import type { ToolHandlerContext } from "../types.ts";
function contextFor(tables:Record<string,Record<string,unknown>[]>,calls:string[]){
 const admin={from(table:string){const filters:Array<[string,unknown]>=[];let limit=0;const query:any={select(){calls.push(table+".select");return query;},eq(k:string,v:unknown){filters.push([k,v]);return query;},in(k:string,v:unknown[]){filters.push([k,v]);return query;},order(){return query;},limit(n:number){limit=n;return query;},then(resolve:(v:any)=>unknown,reject:(e:unknown)=>unknown){let rows=(tables[table]??[]).filter(r=>filters.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v));if(limit)rows=rows.slice(0,limit);return Promise.resolve({data:rows,error:null}).then(resolve,reject);}};return query;}} as any;
 return {admin,brand:{brandKey:"brand-a",role:"owner",display_name:"A",website:"https://a.test",website_host:"a.test",aliases:[],is_active:true},userId:"user",user:{id:"user",email:""},role:"owner",requestId:"test",source:"test"} as ToolHandlerContext;
}
const question=(id:string,branded:boolean)=>({id,text:"sample question",topic:"topic",origin:"manual",status:"active",branded,cohort:"core",duplicateReason:null,createdAt:"2026-11-01T00:00:00.000Z",archivedAt:null});
test("measurement status uses the active panel and workspace-scoped recent scans",async()=>{
 const calls:string[]=[];const ctx=contextFor({scan_jobs:[{id:"j1",brand_key:"brand-a",status:"completed",created_at:"2026-11-01",result_id:"s1"},{id:"j2",brand_key:"brand-b",status:"running"}],scans:[{id:"s1",brand_key:"brand-a",origin_job_id:"j1",visibility_pct:75,prompts_tracked:4,prompts_mentioned:3,scanned_at:"2026-11-01"}]},calls);
 const tool=createMeasurementStatusTool({enabled:async()=>false,listQuestions:async(_ctx,input)=>{assert.equal(input.status,"active");return {questions:[question("q1",true),question("q2",false)],approvedVersion:4,dirty:true};}});
 const result=await tool.handler(ctx,{}) as any;
 assert.deepEqual(result.panel,{approvedVersion:4,dirty:true,active:2,branded:1});assert.equal(result.latestScans.length,1);assert.equal(result.latestScans[0].scanId,"s1");assert.equal(result.latestScans[0].answered,3);assert.equal(result.schedule,null);assert.ok(calls.includes("scan_jobs.select"));
});
test("measurement schedule is read only when its feature flag is enabled",async()=>{
 const ctx=contextFor({scan_jobs:[],scans:[]},[]);let scheduleReads=0;
 const tool=createMeasurementStatusTool({enabled:async()=>true,listQuestions:async()=>({questions:[],approvedVersion:null,dirty:false}),schedule:async()=>{scheduleReads++;return {status:"on",engines:"chatgpt"};}});
 const result=await tool.handler(ctx,{}) as any;
 assert.equal(scheduleReads,1);assert.equal(result.schedule.status,"on");assert.ok(Array.isArray(result.enginesConfigured));
});
