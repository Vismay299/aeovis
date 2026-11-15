import test from "node:test";
import assert from "node:assert/strict";
import { availableTools,filterOwnerTools,getTool,TOOL_REGISTRY } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import type { ToolRegistration } from "./types.ts";

test("Phase 1 registry rows are sorted, lookupable, and a subset of declared tool names",()=>{
 const names=TOOL_REGISTRY.map(r=>r.def.name);
 assert.deepEqual(names,[...names].sort((a,b)=>a.localeCompare(b)));
 assert.ok(names.length>0);
 assert.ok(names.every(name=>(TOOL_NAMES as readonly string[]).includes(name)));
 for(const name of names)assert.equal(getTool(name)?.def.name,name);
 assert.equal(getTool("not_a_tool"),null);
});

test("availableTools evaluates each feature once and fails closed on rejected flags",async()=>{
 const calls:string[]=[];
 const member=await availableTools({brandKey:"brand-a",role:"member"},{isFeatureEnabled:async(feature,key)=>{calls.push(feature+":"+key);if(feature==="question_curation")throw new Error("fixture");return true;}});
 assert.deepEqual(calls.sort(),["project_memory:brand-a","question_curation:brand-a"]);
 assert.ok(member.every(r=>r.feature!=="question_curation"));
 assert.ok(member.every(r=>!r.ownerOnly));
});

test("owner filtering retains owner-only rows only for owners",()=>{
 const fixture={ownerOnly:true} as ToolRegistration;
 assert.deepEqual(filterOwnerTools([fixture],"member"),[]);
 assert.deepEqual(filterOwnerTools([fixture],"owner"),[fixture]);
});
