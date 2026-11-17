import crypto from "node:crypto";
import { createProbeDispatchStore, hashIdentity } from "../db/probeDispatch.js";
import { createMeasurementEvidenceStore } from "../db/measurementEvidence.js";
import { pruneProbeEvidence } from "../evidenceRetention.js";
import {evidenceRedactionStatus} from "../evidenceRedaction.js";

const validRun = id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id || "");
const brandKey = (run, suffix) => `qa-p0-${run}-${suffix}.example`;
const observationId = run => hashIdentity({qualification:"private-evidence",run});
const checked = async request => {const r=await request;if(r.error)throw Error("QA fixture operation failed");return r.data;};

// This creates only two disposable, confirmed QA identities. No mail is sent,
// no customer account is changed, and provider dispatch is not part of this check.
export async function prepareEvidenceQualification(admin, run) {
  if(!validRun(run))throw Error("Invalid QA run");
  const password=crypto.randomBytes(32).toString("base64url"), users=[];
  try {
    for(const suffix of ["a","b"]){
      const email=`qa-p0-${run}-${suffix}@example.invalid`;
      const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{p0_qualification_run:run}});
      if(error || !data?.user)throw Error("Could not prepare disposable QA authentication");
      users.push({id:data.user.id,email,brand_key:brandKey(run,suffix)});
      await checked(admin.from("customer_brands").insert({brand_key:brandKey(run,suffix),display_name:`P0 qualification ${suffix.toUpperCase()}`,website:"https://perceev.ai",website_host:"perceev.ai",is_active:true}));
      await checked(admin.from("customer_brand_memberships").insert({brand_key:brandKey(run,suffix),user_id:data.user.id,role:"owner"}));
    }
    const job=crypto.randomUUID();
    const control=await checked(admin.from("probe_dispatch_control").select("*").eq("singleton",true).single());
    if(control.paused)await checked(admin.rpc("set_probe_rollout",{p_paused:true,p_canaries:control.canaries_allowed,p_brands:[users[0].brand_key]}));
    await checked(admin.from("scan_jobs").insert({id:job,brand:"P0 storage qualification fixture",url:"https://perceev.ai",brand_key:users[0].brand_key,status:"complete",query_source:"qa_fixture",checkpoint:{prompt_key:users[0].brand_key},run_record:{isSample:true,qualification_fixture:true}}));
    const store=createProbeDispatchStore(admin), id=observationId(run);
    await store.seed([{id,job_id:job,purpose:"scan",engine:"aio",query:"QA storage fixture; no provider called",context:{qualification_fixture:true,qa_run_id:run},config_version:"qa-fixture-only",circuit_key:`qa-fixture:${run}`,deadline_at:new Date(Date.now()+300_000).toISOString()}]);
    const claim=await store.claim(id,{reserve:0.01,scanCap:0.01});
    if(!claim.granted)throw Error("QA fixture claim refused");
    const capture=await createMeasurementEvidenceStore(admin).capture({observationId:id,token:claim.lease_token,surface:"qa_fixture",provider:"qa_fixture",payload:JSON.stringify({qualification_fixture:true,text:"Private QA response capture",headers:{"set-cookie":'EXAMPLE-NOT-A-REAL-QA-COOKIE="quoted"; second=EXAMPLE-NOT-A-REAL-TAIL'},body:JSON.stringify({answer:"QA nested body",authorization:"Bearer EXAMPLE-NOT-A-REAL-QA-TOKEN"})})});
    await store.finish(id,claim.lease_token,{engine:"aio",serp_state:"valid_serp",aio_present:false,answer_present:false,brand_mentioned_in_text:false,brand_cited:false,is_branded_query:false,text:"",brands:[],cost:0,qualification_fixture:true,attempt_id:claim.lease_token,evidence_state:"stored",evidence_captures:[capture],provenance:{method:"qa_fixture",qualification_fixture:true}},{state:"valid_no_aio",failure:null,next_at:null});
    if(capture.state!=="stored")throw Error("Hosted JSON evidence upload failed");
    // A second expired capture proves the customer route refuses retention expiry
    // before signing, even though the private object still exists for cleanup.
    const expired=await createMeasurementEvidenceStore(admin).capture({observationId:id,token:claim.lease_token,index:1,surface:"qa_fixture",provider:"qa_fixture",capturedAt:new Date(Date.now()-91*86400_000).toISOString(),payload:{qualification_fixture:true,expired:true}});
    if(expired.state!=="stored")throw Error("Could not prepare expired evidence fixture");
    // Actual hosted bucket rejection, with real durable failure metadata.
    const failed=await createMeasurementEvidenceStore({from:admin.from.bind(admin),storage:{from:bucket=>({upload:(key,body,options)=>admin.storage.from(bucket).upload(key,body,{...options,contentType:"application/x-p0-denied-fixture"})})}}).capture({observationId:id,token:claim.lease_token,index:2,surface:"qa_fixture",provider:"qa_fixture",payload:{qualification_fixture:true,rejected_upload:true}});
    if(failed.state!=="write_failed")throw Error("Hosted rejection was not retained as incomplete evidence");
    // Deliberate legacy fault injection with fixed, unmistakably fake cookie
    // material. It exercises privacy retraction; no real secret is introduced.
    const legacyBody=JSON.stringify({schema:"measurement-evidence-v1",provider:"qa_fixture",surface:"qa_fixture",payload:'{"headers":{"[REDACTED]EXAMPLE-NOT-A-REAL-LEGACY-COOKIE"}'});
    const legacyHash=crypto.createHash("sha256").update(legacyBody).digest("hex"),legacyKey=`measurements/${id}/${claim.lease_token}/3-${legacyHash}.json`;
    await checked(admin.storage.from("probe-evidence").upload(legacyKey,legacyBody,{contentType:"application/json",upsert:true}));
    await checked(admin.from("measurement_evidence").upsert({observation_id:id,attempt_token:claim.lease_token,capture_index:3,state:"stored",surface:"qa_fixture",object_key:legacyKey,sha256:legacyHash,captured_at:new Date().toISOString(),expires_at:new Date(Date.now()+90*86400_000).toISOString(),reason:"qa_legacy_redaction_fixture"},{onConflict:"observation_id,attempt_token,capture_index"}));
    return {run_id:run,users,password,job_id:job,observation_id:id,attempt:claim.lease_token,object_key:capture.object_key,expired_object_key:expired.object_key,legacy_redaction_sha256:legacyHash,qualification:"Disposable QA identities and controlled provider fixture; actual hosted Auth, database and private Storage. Zero provider requests."};
  } catch(error){
    await cleanupEvidenceQualification(admin,run,users.map(u=>u.id));
    throw error;
  }
}

export async function verifyEvidenceRetention(admin,run){
  if(!validRun(run))throw Error("Invalid QA run");
  const id=observationId(run);
  const observation=await checked(admin.from("probe_observations").select("context").eq("id",id).single());
  if(observation.context?.qa_run_id!==run || observation.context?.qualification_fixture!==true)throw Error("QA evidence scope mismatch");
  const captures=await checked(admin.from("measurement_evidence").select("object_key").eq("observation_id",id).eq("capture_index",0));
  const key=captures?.[0]?.object_key;
  if(!key || !key.startsWith(`measurements/${id}/`))throw Error("QA object scope mismatch");
  const bucket=admin.storage.from("probe-evidence");
  const sign=await bucket.createSignedUrl(key,3);if(sign.error)throw Error("QA signing failed");
  const initial=await fetch(sign.data.signedUrl,{cache:"no-store",signal:AbortSignal.timeout(10000)});
  if(initial.status!==200)throw Error("Fresh signed URL could not read private evidence");
  await initial.arrayBuffer();
  const claims=JSON.parse(Buffer.from(new URL(sign.data.signedUrl).searchParams.get("token").split(".")[1],"base64url").toString());
  const waitMs=Math.max(0,claims.exp*1000-Date.now()+1200);
  if(waitMs>6000)throw Error("Unexpected QA signing TTL");
  await new Promise(resolve=>setTimeout(resolve,waitMs));
  const expiredUrl=new URL(sign.data.signedUrl);expiredUrl.searchParams.set("qa_cache_bust",crypto.randomUUID());
  const expiredRead=await fetch(expiredUrl,{cache:"no-store",signal:AbortSignal.timeout(10000)});await expiredRead.arrayBuffer();
  if(expiredRead.status<400)throw Error("Expired signed URL remained readable");
  const report=await pruneProbeEvidence({client:admin,prefix:`measurements/${id}`,now:()=>new Date(Date.now()+91*86400_000)});
  if(report.removed!==2 || report.scanned!==2 || report.truncated)throw Error("Scoped QA retention did not remove exactly two fixture objects");
  const rows=await checked(admin.from("measurement_evidence").select("state").eq("observation_id",id).in("capture_index",[0,1]));
  if(rows.length!==2 || rows.some(r=>r.state!=="expired"))throw Error("Retention metadata mismatch");
  return {run_id:run,passed:["actual hosted private JSON capture","actual bucket rejection retained as write_failed","fresh signed URL readable","expired signed URL refused","retention removed only two QA objects and persisted expiry"],retention_clock:"accelerated for this exact QA prefix only; no customer objects inspected or removed",provider_requests:0};
}

export async function cleanupEvidenceQualification(admin, run, userIds) {
  if(!validRun(run) || !Array.isArray(userIds) || userIds.length>2)throw Error("Invalid QA cleanup scope");
  // Validate every identity before deleting anything; arbitrary account IDs are refused.
  for(const id of userIds){
    const {data,error}=await admin.auth.admin.getUserById(id);
    if(error || data.user?.user_metadata?.p0_qualification_run!==run)throw Error("QA identity ownership mismatch");
  }
  const workspaceKeys=[brandKey(run,"a"),brandKey(run,"b")];
  const jobs=await checked(admin.from("scan_jobs").select("id,query_source").in("brand_key",workspaceKeys));
  if(jobs.some(job=>job.query_source!=="qa_fixture"))throw Error("Real QA scan history is retained; fixture cleanup refused");
  const reports=await checked(admin.from("scans").select("id").in("brand_key",workspaceKeys).limit(1));
  if(reports.length)throw Error("Real QA report history is retained; fixture cleanup refused");
  const id=observationId(run), keys=await checked(admin.from("measurement_evidence").select("object_key").eq("observation_id",id));
  if(keys?.length)await checked(admin.storage.from("probe-evidence").remove(keys.map(r=>r.object_key).filter(Boolean)));
  const observations=await checked(admin.from("probe_observations").select("job_id").eq("id",id));
  for(const table of ["measurement_evidence","probe_late_receipts","probe_reconciliations","probe_attempts"])
    await checked(admin.from(table).delete().eq("observation_id",id));
  await checked(admin.from("probe_observations").delete().eq("id",id));
  for(const row of observations || [])if(row.job_id)await checked(admin.from("prompt_results").delete().eq("job_id",row.job_id).eq("brand",brandKey(run,"a")));
  await checked(admin.from("scan_jobs").delete().eq("query_source","qa_fixture").in("brand_key",[brandKey(run,"a"),brandKey(run,"b")]));
  await checked(admin.from("provider_dispatch_circuits").delete().eq("circuit_key",`qa-fixture:${run}`));
  const control=await checked(admin.from("probe_dispatch_control").select("*").eq("singleton",true).single());
  if(control.brand_allowlist?.includes(brandKey(run,"a")))await checked(admin.rpc("set_probe_rollout",{p_paused:control.paused,p_canaries:control.canaries_allowed,p_brands:[]}));
  for(const key of [brandKey(run,"a"),brandKey(run,"b")]){
    // The workspace guard correctly refuses deleting its last owner. These
    // disposable identities were validated above; demote only their scoped
    // fixture memberships before removing the fixture workspace and users.
    if(userIds.length)await checked(admin.from("customer_brand_memberships").update({role:"member"}).eq("brand_key",key).in("user_id",userIds));
    await checked(admin.from("customer_brand_memberships").delete().eq("brand_key",key));
    await checked(admin.from("customer_brands").delete().eq("brand_key",key));
  }
  for(const id of userIds){const r=await admin.auth.admin.deleteUser(id);if(r.error)throw Error("QA authentication cleanup failed");}
  return {cleaned:true,run_id:run,provider_requests:0};
}

// Privacy retraction is restricted to explicit QA/canary observations. Preserve
// every paid attempt/result and the old hash; remove only unsafe raw objects.
export async function withdrawQaRedaction(admin,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>!/^([a-f0-9]{64})$/.test(id)))throw Error("Invalid QA evidence scope");
  const observations=await checked(admin.from("probe_observations").select("id,purpose,context,scan_jobs!probe_observations_job_id_fkey(brand_key)").in("id",ids));
  if(observations.length!==new Set(ids).size || observations.some(o=>!(
    (o.purpose==="canary" && /^provider-canary:qa-[a-z0-9-]+$/.test(o.context?.budget_scope||"")) ||
    /^qa-p0-[a-f0-9-]{36}-[ab]\.example$/.test(o.scan_jobs?.brand_key||""))))throw Error("Evidence is outside the authorized QA scope");
  for(const observation of observations){
    if(observation.purpose==="canary")continue;
    const key=observation.scan_jobs.brand_key,run=/^qa-p0-(.{36})-[ab]\.example$/.exec(key)?.[1];
    const members=await checked(admin.from("customer_brand_memberships").select("user_id").eq("brand_key",key).eq("role","owner").limit(5));
    let verified=false;
    for(const member of members){const {data,error}=await admin.auth.admin.getUserById(member.user_id);if(!error && data?.user?.user_metadata?.p0_qualification_run===run)verified=true;}
    if(!verified)throw Error("QA evidence ownership could not be verified");
  }
  const captures=await checked(admin.from("measurement_evidence").select("*").in("observation_id",ids));
  const bucket=admin.storage.from("probe-evidence"),results=[];
  for(const capture of captures){
    if(!capture.object_key || !capture.object_key.startsWith(`measurements/${capture.observation_id}/`))continue;
    let status={safe:false,reason:"redaction_retracted"};
    if(capture.reason!=="redaction_retracted"){
      const response=await bucket.download(capture.object_key);
      if(response.error){if(capture.state==="expired")continue;throw Error("Could not inspect scoped QA capture");}
      try{status=evidenceRedactionStatus(JSON.parse(await response.data.text()));}catch{status={safe:false,reason:"malformed_json_capture"};}
    }
    if(status.safe){results.push({observation_id:capture.observation_id,index:capture.capture_index,status:"safe"});continue;}
    await checked(admin.from("measurement_evidence").update({state:"expired",reason:"redaction_retracted"}).eq("observation_id",capture.observation_id).eq("attempt_token",capture.attempt_token).eq("capture_index",capture.capture_index));
    await checked(bucket.remove([capture.object_key]));
    results.push({observation_id:capture.observation_id,index:capture.capture_index,status:"withdrawn",reason:status.reason,sha256:capture.sha256});
  }
  return {results,paid_history_preserved:true,provider_requests:0};
}
