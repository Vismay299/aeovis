import test from "node:test";
import assert from "node:assert/strict";
import {evidenceDocument} from "./db/measurementEvidence.js";
import {evidenceRedactionStatus} from "./evidenceRedaction.js";
import {withdrawQaRedaction} from "./ops/evidenceQualification.js";

test("structured redaction remains parseable and verifiable through nested JSON strings",()=>{
  const payload=JSON.stringify({headers:{"set-cookie":"EXAMPLE-NOT-A-REAL-COOKIE=one; other=two"},body:JSON.stringify({answer:"Public response",authorization:"Bearer EXAMPLE-NOT-A-REAL-TOKEN"})});
  const doc=evidenceDocument({payload,provider:"fixture",surface:"aio"});
  assert.equal(doc.document.redaction_version,"structured-json-v2");
  assert.deepEqual(evidenceRedactionStatus(doc.document),{safe:true,reason:null});
  assert.equal(doc.body.includes("EXAMPLE-NOT-A-REAL"),false);
  assert.equal(JSON.parse(JSON.parse(doc.document.payload).body).answer,"Public response");
});

test("old malformed JSON captures and complete unredacted cookie values are rejected without source-bearing parser errors",()=>{
  assert.deepEqual(evidenceRedactionStatus({payload:'{"headers":{"[REDACTED]EXAMPLE-NOT-A-REAL-TAIL"}'}),{safe:false,reason:"malformed_json_capture"});
  assert.equal(evidenceRedactionStatus({payload:JSON.stringify({headers:{"set-cookie":"EXAMPLE-NOT-A-REAL-COOKIE=one; second=two"}})}).safe,false);
});

test("old plain-text captures with cookie pairs left after the first semicolon are rejected",()=>{
  assert.deepEqual(evidenceRedactionStatus({payload:"Set-Cookie: [REDACTED]; EXAMPLE-NOT-A-REAL-SECOND=b\nPublic answer"}),{safe:false,reason:"unredacted_sensitive_field"});
  const doc=evidenceDocument({payload:"Set-Cookie: EXAMPLE-NOT-A-REAL-FIRST=a; EXAMPLE-NOT-A-REAL-SECOND=b\nPublic answer",provider:"fixture",surface:"aio"});
  assert.deepEqual(evidenceRedactionStatus(doc.document),{safe:true,reason:null});
  assert.equal(doc.body.includes("EXAMPLE-NOT-A-REAL"),false);assert.ok(doc.body.includes("Public answer"));
});

test("privacy withdrawal validates all observations before any object or paid history is touched",async()=>{
  const id="a".repeat(64);let storageCalls=0;
  const admin={from(table){assert.equal(table,"probe_observations");return {select(){return this;},in:async()=>({data:[{id,purpose:"scan",scan_jobs:{brand_key:"customer.example"},context:{}}],error:null})};},storage:{from(){storageCalls++;throw Error("Unexpected storage access");}}};
  await assert.rejects(()=>withdrawQaRedaction(admin,[id]),/outside.*QA scope/);assert.equal(storageCalls,0);
});

test("privacy withdrawal revokes the exact unsafe QA object and retains its hash without rewriting paid attempts",async()=>{
  const id="a".repeat(64),key=`measurements/${id}/fixture/capture.json`,events=[];
  const admin={from(table){
    if(table==="probe_observations")return {select(){return this;},in:async()=>({data:[{id,purpose:"canary",context:{budget_scope:"provider-canary:qa-redaction-test"}}],error:null})};
    assert.equal(table,"measurement_evidence");let update=null;
    return {select(){return this;},in:async()=>({data:[{observation_id:id,attempt_token:"fixture-token",capture_index:0,object_key:key,sha256:"old-hash",state:"stored"}],error:null}),update(value){update=value;return this;},eq(){return this;},then(resolve){events.push({update});resolve({data:[],error:null});}};
  },storage:{from(){return {download:async()=>({data:new Blob([JSON.stringify({payload:'{"[REDACTED]EXAMPLE-NOT-A-REAL-TAIL"}'})]),error:null}),remove:async keys=>{events.push({removed:keys});return {data:[],error:null};}};}}};
  const result=await withdrawQaRedaction(admin,[id]);
  assert.deepEqual(events,[{update:{state:"expired",reason:"redaction_retracted"}},{removed:[key]}]);assert.equal(result.paid_history_preserved,true);assert.equal(result.results[0].sha256,"old-hash");assert.equal(result.results[0].status,"withdrawn");
});

test("a QA-shaped workspace name is insufficient without verified QA Auth ownership",async()=>{
  const id="a".repeat(64),run="11111111-1111-4111-8111-111111111111";let storageCalls=0;
  const admin={auth:{admin:{getUserById:async()=>({data:{user:{user_metadata:{p0_qualification_run:"another-run"}}},error:null})}},from(table){
    if(table==="probe_observations")return {select(){return this;},in:async()=>({data:[{id,purpose:"scan",context:{},scan_jobs:{brand_key:`qa-p0-${run}-a.example`}}],error:null})};
    assert.equal(table,"customer_brand_memberships");return {select(){return this;},eq(){return this;},limit:async()=>({data:[{user_id:"foreign-user"}],error:null})};
  },storage:{from(){storageCalls++;throw Error("Unexpected storage access");}}};
  await assert.rejects(()=>withdrawQaRedaction(admin,[id]),/ownership could not be verified/);assert.equal(storageCalls,0);
});
