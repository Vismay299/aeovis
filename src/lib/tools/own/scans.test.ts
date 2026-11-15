import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../http/appError.ts";
import { getScanAnswerTool,getScanReportTool,getScanSourcesTool } from "./scans.ts";
import type { ToolHandlerContext } from "../types.ts";

type Row=Record<string,any>;
function fakeAdmin(tables:Record<string,Row[]>){
 const calls:string[]=[];
 const admin={from(table:string){
  const filters:Array<[string,unknown]>=[];const state={limit:0,columns:""};
  const query:any={
   select(columns:string){state.columns=columns;calls.push(table+".select:"+columns);return query;},
   eq(column:string,value:unknown){filters.push([column,value]);return query;},
   in(column:string,values:unknown[]){filters.push([column,values]);return query;},
   order(){return query;},limit(n:number){state.limit=n;return query;},
   maybeSingle(){const row=(tables[table]??[]).find(r=>filters.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v))??null;return Promise.resolve({data:row,error:null});},
   then(resolve:(v:any)=>unknown,reject:(e:unknown)=>unknown){let rows=(tables[table]??[]).filter(r=>filters.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v));if(state.limit)rows=rows.slice(0,state.limit);return Promise.resolve({data:rows,error:null}).then(resolve,reject);},
  };return query;
 }} as any;
 const context={admin,brand:{brandKey:"brand-a",role:"owner",display_name:"A",website:"https://a.test",website_host:"a.test",aliases:[],is_active:true},userId:"user",user:{id:"user",email:""},role:"owner",requestId:"test",source:"test"} as ToolHandlerContext;
 return {context,calls};
}
const SCAN="9e8d0000-0000-4000-8000-000000000001";
const RESULT="6a1f0000-0000-4000-8000-000000000001";

test("foreign scan refusal happens before reading prompt results",async()=>{
 const {context,calls}=fakeAdmin({scans:[{id:SCAN,brand_key:"brand-b",raw_results:{}}],prompt_results:[{id:RESULT,scan_id:SCAN}]});
 await assert.rejects(()=>getScanReportTool.handler(context,{scanId:SCAN}),e=>e instanceof AppError&&e.code==="scan_not_found");
 assert.equal(calls.some(call=>call.startsWith("prompt_results.")),false);
});

test("onlyGaps keeps rows with an absent brand and a named competitor; report query omits answer text",async()=>{
 const {context,calls}=fakeAdmin({
  scans:[{id:SCAN,brand_key:"brand-a",scanned_at:"2026-11-01",visibility_pct:50,raw_results:{planned_questions:3,engines:["chatgpt"],competitors:["Rival"]}}],
  prompt_results:[
   {id:RESULT,scan_id:SCAN,query:"q1",engine:"chatgpt",answered:true,mentioned:false,brand_cited:false,position:1,raw:{brands:[{name:"Rival",is_self:false,mentioned:true}]},answer_text:"secret answer"},
   {id:"6a1f0000-0000-4000-8000-000000000002",scan_id:SCAN,query:"q2",engine:"chatgpt",answered:true,mentioned:true,raw:{brands:[{name:"Rival",mentioned:true}]}},
   {id:"6a1f0000-0000-4000-8000-000000000003",scan_id:SCAN,query:"q3",engine:"chatgpt",answered:false,mentioned:false,raw:{brands:[]}},
  ],
 });
 const out=await getScanReportTool.handler(context,{scanId:SCAN,onlyGaps:true}) as any;
 assert.equal(out.rows.length,1);
 assert.equal(out.rows[0].resultId,RESULT);
 assert.equal(out.rows[0].competitorsNamed[0],"Rival");
 assert.equal(JSON.stringify(out).includes("secret answer"),false);
 const selection=calls.find(call=>call.startsWith("prompt_results.select:"));
 assert.ok(selection);
 assert.equal(selection.includes("answer_text"),false);
});

test("scan answer is truncated at 6,000 characters",async()=>{
 const text="x".repeat(6100);
 const {context}=fakeAdmin({prompt_results:[{id:RESULT,scan_id:SCAN,query:"q",engine:"chatgpt",answered:true,mentioned:false,brand_cited:false,answer_text:text}],scans:[{id:SCAN,brand_key:"brand-a"}]});
 const answer=await getScanAnswerTool.handler(context,{resultId:RESULT}) as any;
 assert.equal(answer.answer.length,6000);
 assert.equal(answer.truncated,true);
});

test("scan sources are grouped by domain and count distinct citing answers",async()=>{
 const {context}=fakeAdmin({scans:[{id:SCAN,brand_key:"brand-a"}],citations:[
  {domain:"docs.example.test",url:"https://docs.example.test/a",brand:"brand-a",scan_id:SCAN,result_id:RESULT,engine:"chatgpt",is_own:false},
  {domain:"docs.example.test",url:"https://docs.example.test/b",brand:"brand-a",scan_id:SCAN,result_id:RESULT,engine:"gemini",is_own:false},
  {domain:"docs.example.test",url:"https://docs.example.test/c",brand:"brand-a",scan_id:SCAN,result_id:"r2",engine:"gemini",is_own:false},
 ]});
 const out=await getScanSourcesTool.handler(context,{scanId:SCAN}) as any;
 assert.equal(out.totalCount,1);
 assert.equal(out.sources[0].answersCiting,2);
 assert.deepEqual(out.sources[0].engines,["chatgpt","gemini"]);
});
