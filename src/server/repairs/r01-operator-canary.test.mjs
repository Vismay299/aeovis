import test from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
register("../cronAuth.route.hooks.mjs",import.meta.url);
const {POST}=await import("../../app/api/measurement/canary/route.js");
const {cleanupEvidenceQualification}=await import("../ops/evidenceQualification.js");
const valid={slot:"qa-p0-regression",engines:["aio","chatgpt"],max_requests:4,max_spend_usd:1,reserve_usd:0.2};
const request=(body,headers={})=>new Request("https://app.example/api/measurement/canary",{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
test("R01: operator canary rejects invalid slots, duplicate engines and excessive budgets before dispatch",async()=>{
  let dispatched=0;
  const deps={getSupabaseAdmin:()=>({rpc:()=>{throw Error("not needed");}}),dispatchCanaries:async()=>{dispatched++;return [];}};
  for(const patch of [{slot:""},{engines:["aio","aio"]},{engines:["unknown"]},{max_requests:13},{max_requests:1.5},{max_spend_usd:11},{reserve_usd:2},{max_spend_usd:0}])assert.equal((await POST(request({...valid,...patch}),{},deps)).status,400);
  assert.equal((await POST(request(valid,{origin:"https://other.example"}),{},deps)).status,403);
  assert.equal(dispatched,0);
  const response=await POST(request(valid),{},deps);assert.equal(response.status,200);assert.equal(dispatched,1);
});
test("R01: missing canary database and dispatch failure remain explicit refusals",async()=>{
  assert.equal((await POST(request(valid),{},{getSupabaseAdmin:()=>null})).status,503);
  const response=await POST(request(valid),{},{getSupabaseAdmin:()=>({rpc:()=>{}}),dispatchCanaries:async()=>{throw Error("untrusted provider detail");}});
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/untrusted provider detail/);
});
test("P0 hosted QA cleanup refuses foreign identities before any destructive operation",async()=>{
  let writes=0;
  const admin={auth:{admin:{getUserById:async()=>({data:{user:{user_metadata:{p0_qualification_run:"other"}}}})}},from:()=>{writes++;throw Error("destructive query reached");}};
  await assert.rejects(()=>cleanupEvidenceQualification(admin,"not-a-run",[]),/Invalid QA/);
  await assert.rejects(()=>cleanupEvidenceQualification(admin,"3d738bb1-719e-49bc-af05-3084a1520673",["foreign-user"]),/ownership mismatch/);
  assert.equal(writes,0);
});
