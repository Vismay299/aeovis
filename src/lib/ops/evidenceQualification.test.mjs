import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupEvidenceQualification} from './evidenceQualification.js';
const run='11111111-1111-4111-8111-111111111111';

test('QA cleanup rejects a foreign identity before any fixture or membership mutation',async()=>{
  let writes=0;
  const admin={auth:{admin:{getUserById:async()=>({data:{user:{user_metadata:{p0_qualification_run:'another-run'}}},error:null})}},from(){writes++;throw Error('Unexpected mutation');},storage:{from(){writes++;throw Error('Unexpected storage mutation');}}};
  await assert.rejects(()=>cleanupEvidenceQualification(admin,run,['foreign-user']),/ownership mismatch/);
  assert.equal(writes,0);
});

test('QA cleanup validates every identity before touching either workspace',async()=>{
  let writes=0,reads=0;
  const admin={auth:{admin:{getUserById:async id=>{reads++;return {data:{user:{user_metadata:{p0_qualification_run:id==='owned-user'?run:'another-run'}}},error:null};}}},from(){writes++;throw Error('Unexpected mutation');}};
  await assert.rejects(()=>cleanupEvidenceQualification(admin,run,['owned-user','foreign-user']),/ownership mismatch/);
  assert.equal(reads,2);assert.equal(writes,0);
});

test('QA fixture cleanup refuses a real paid-workflow job before deleting objects, reports or memberships',async()=>{
  let storageCalls=0;
  const admin={auth:{admin:{getUserById:async()=>({data:{user:{user_metadata:{p0_qualification_run:run}}},error:null})}},from(table){assert.equal(table,'scan_jobs');return {select(){return this;},in:async()=>({data:[{id:'real-job',query_source:'reviewed_panel'}],error:null})};},storage:{from(){storageCalls++;throw Error('Unexpected mutation');}}};
  await assert.rejects(()=>cleanupEvidenceQualification(admin,run,['owned-user']),/Real QA scan history is retained/);assert.equal(storageCalls,0);
});
