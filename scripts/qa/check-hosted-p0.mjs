#!/usr/bin/env node
// Actual hosted Auth/tenant/Storage/browser check. Fixture credentials and bypass
// cookies are consumed from private files and are never printed or committed.
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {chromium} from "../../worker/node_modules/playwright/index.mjs";
const [origin,fixturePath,cookiePath]=process.argv.slice(2);
let stage="input",browser,fixture,operatorContext,cleaned=false,paidRequests=0;
const passed=[];
try{
  const host=new URL(origin).hostname;
  assert.match(host,/^aeo-[a-z0-9]+-vismays-projects-e0c6f290\.vercel\.app$/);
  assert.ok(process.env.OPERATOR_TOKEN && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  fixture=JSON.parse(await readFile(fixturePath,"utf8"));
  assert.equal(fixture.users?.length,2);assert.ok(fixture.password && fixture.attempt);
  const cookies=(await readFile(cookiePath,"utf8")).split("\n").flatMap(line=>{
    const httpOnly=line.startsWith("#HttpOnly_");if(httpOnly)line=line.slice(10);
    if(!line || line.startsWith("#"))return [];
    const [domain,,path,secure,expires,name,value]=line.split("\t");
    return name && value ? [{domain,path,secure:secure==="TRUE",expires:Number(expires)||-1,name,value,httpOnly,sameSite:"None"}] : [];
  });
  browser=await chromium.launch({headless:true});
  async function context(){const c=await browser.newContext();await c.addCookies(cookies);await c.route("**/api/**",route=>{
    if(route.request().method()==="POST" && /\/api\/(?:scan$|customer\/scan(?:\?|$))/.test(route.request().url())){paidRequests++;return route.abort();}
    return route.continue();
  });return c;}
  operatorContext=await context();
  async function operator(action){
    const r=await operatorContext.request.post(`${origin}/api/measurement/qualification`,{headers:{"x-operator-token":process.env.OPERATOR_TOKEN,origin},data:{action,run_id:fixture.run_id,user_ids:fixture.users.map(u=>u.id)},timeout:120000});
    if(r.status()!==200)throw Object.assign(Error("QA operator action failed"),{code:`qa_http_${r.status()}`});
    return r.json();
  }
  const api=(user,index=0)=>`${origin}/api/customer/measurement/evidence?brand_key=${encodeURIComponent(user.brand_key)}&observation=${fixture.observation_id}&attempt=${fixture.attempt}&index=${index}`;
  stage="anonymous access";
  const anonymous=await context();
  assert.equal((await anonymous.request.get(api(fixture.users[0]),{maxRedirects:0})).status(),401);
  assert.equal((await anonymous.request.post(`${origin}/api/measurement/qualification`,{data:{action:"prepare",run_id:fixture.run_id},maxRedirects:0})).status(),401);
  passed.push("Anonymous evidence access and privileged QA preparation are refused before side effects");
  async function signIn(user){
    const c=await context(),page=await c.newPage();
    await page.goto(`${origin}/login?next=${encodeURIComponent("/portal/measurement")}`);
    await page.getByLabel("Work email").fill(user.email);
    await page.getByLabel("Password",{exact:true}).fill(fixture.password);
    const auth=page.waitForResponse(r=>r.url().includes("/auth/v1/token") && r.request().method()==="POST");
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    const authResponse=await auth;assert.equal(authResponse.status(),200);const session=await authResponse.json();
    await page.getByRole("heading",{name:"Questions and evidence",exact:true}).waitFor({timeout:45000});
    return {c,page,token:session.access_token};
  }
  stage="owner browser sign-in";
  const owner=await signIn(fixture.users[0]);
  const detail=owner.page.locator("details").filter({hasText:"aio · valid_no_aio"}).first();await detail.waitFor();await detail.locator("summary").click();
  await owner.page.getByRole("link",{name:"Open private response capture 1",exact:true}).waitFor();
  const read=await owner.c.request.get(api(fixture.users[0]),{maxRedirects:0});assert.equal(read.status(),302);assert.equal(read.headers()["cache-control"],"no-store");
  const signed=read.headers().location;
  const claims=JSON.parse(Buffer.from(new URL(signed).searchParams.get("token").split(".")[1],"base64url").toString());assert.ok(claims.exp-Math.floor(Date.now()/1000)<=120);
  const capture=await owner.c.request.get(signed);assert.equal(capture.status(),200);assert.equal((await capture.json()).payload.qualification_fixture,true);
  assert.equal((await owner.c.request.get(api(fixture.users[0],1),{maxRedirects:0})).status(),410);
  assert.equal((await owner.c.request.get(api(fixture.users[0],2),{maxRedirects:0})).status(),409);
  passed.push("Actual customer login/browser opens its owned private JSON capture; expired and failed uploads remain distinct");
  stage="second tenant browser sign-in";
  const other=await signIn(fixture.users[1]);
  assert.equal((await other.c.request.get(api(fixture.users[1]),{maxRedirects:0})).status(),404);
  assert.equal((await other.c.request.get(api(fixture.users[0]),{maxRedirects:0})).status(),404);
  const history=await other.c.request.get(`${origin}/api/customer/measurement?brand_key=${encodeURIComponent(fixture.users[1].brand_key)}`);assert.equal(history.status(),200);assert.deepEqual((await history.json()).observations,[]);
  const storageOrigin=new URL(signed).origin;
  const authHeaders={authorization:`Bearer ${other.token}`,apikey:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY};
  const ownRegistry=await other.c.request.get(`${storageOrigin}/rest/v1/customer_brands?brand_key=eq.${encodeURIComponent(fixture.users[1].brand_key)}`,{headers:authHeaders});assert.equal(ownRegistry.status(),200);assert.equal((await ownRegistry.json()).length,1);
  const unsigned=await anonymous.request.get(`${storageOrigin}/storage/v1/object/public/probe-evidence/${fixture.object_key}`);assert.ok(unsigned.status()>=400);
  const foreignStorage=await other.c.request.get(`${storageOrigin}/storage/v1/object/authenticated/probe-evidence/${fixture.object_key}`,{headers:authHeaders});assert.ok(foreignStorage.status()>=400);
  passed.push("Two actual authenticated tenants remain isolated in history, evidence signing and direct private Storage access");
  stage="hosted signed expiry and scoped retention";
  const retention=await operator("verify_retention");passed.push(...retention.passed);
  stage="expired evidence history refresh";
  await owner.page.reload();await owner.page.getByRole("heading",{name:"Questions and evidence",exact:true}).waitFor();
  await owner.page.locator("details").filter({hasText:"aio · valid_no_aio"}).first().locator("summary").click();
  assert.equal(await owner.page.getByRole("link",{name:/Open private response capture/}).count(),0);
  await owner.page.getByText("Raw capture expired; the measurement is retained.",{exact:true}).first().waitFor();
  stage="health reads remain free of provider dispatch";
  const health=async()=>{const r=await anonymous.request.get(`${origin}/api/health`);assert.equal(r.status(),200);const body=await r.json();assert.equal(body.db.ok,true);return body.provider_readiness;};
  const before=await health();
  const canaries=report=>Object.fromEntries(Object.entries(report.engines).map(([engine,r])=>[engine,{config_version:r.config_version,canary:r.canary}]));
  for(let batch=0;batch<20;batch++){
    const readings=await Promise.all(Array.from({length:5},()=>health()));
    for(const reading of readings)assert.deepEqual(canaries(reading),canaries(before));
  }
  passed.push("R01-12: 100 actual hosted health reads preserve every stored canary without provider dispatch");
  assert.equal(paidRequests,0);
  passed.push("Customer history refresh removes expired capture links and never starts a paid scan");
  stage="fixture cleanup";const cleanup=await operator("cleanup");assert.equal(cleanup.cleaned,true);cleaned=true;
  await writeFile("docs/audits/2026-10-16/p0-hosted-browser-evidence.json",JSON.stringify({suite:"actual-hosted-auth-storage-browser",executed_at:new Date().toISOString(),deployment:origin,run_id:fixture.run_id,passed,paid_requests:paidRequests,fixture_cleanup:cleaned,qualification:"Actual deployed app, two disposable Auth users and owned QA workspaces, real hosted RLS/Storage. Provider text is an explicit fixture. Retention advances time only for its exact QA prefix; no elapsed-day claim."},null,2)+"\n");
  console.log(JSON.stringify({passed:passed.length,paid_requests:paidRequests,fixture_cleanup:cleaned}));
}catch(error){
  const code=error.code || /net::ERR_[A-Z_]+/.exec(error.message || "")?.[0] || (/Timeout/i.test(error.message || "")?"timeout":"browser_operation_failed");
  const failure={suite:"actual-hosted-auth-storage-browser",executed_at:new Date().toISOString(),deployment:origin,outcome:"failed",passed,failed_stage:stage,error_type:error.name,code,paid_requests:paidRequests,qualification:"Partial evidence only; failed stage and cleanup must be resolved before acceptance."};
  await writeFile("docs/audits/2026-10-16/p0-hosted-browser-last-failure.json",JSON.stringify(failure,null,2)+"\n");
  console.error(JSON.stringify({failed:true,stage,error_type:error.name,code}));process.exitCode=1;
}
finally{
  if(!cleaned && operatorContext && fixture?.users){try{const r=await operatorContext.request.post(`${origin}/api/measurement/qualification`,{headers:{"x-operator-token":process.env.OPERATOR_TOKEN,origin},data:{action:"cleanup",run_id:fixture.run_id,user_ids:fixture.users.map(u=>u.id)}});console.log(JSON.stringify({cleanup_status:r.status()}));}catch{console.error("QA cleanup could not be confirmed; private run details retained for recovery.");}}
  if(browser)await browser.close();
}
