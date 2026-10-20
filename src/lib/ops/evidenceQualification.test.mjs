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
