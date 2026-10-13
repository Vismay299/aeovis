import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./customerRoutes.test.hooks.mjs", import.meta.url);
const agents = await import("../app/api/customer/agents/route.js");
const agentItem = await import("../app/api/customer/agents/[id]/route.js");
const content = await import("../app/api/customer/content/route.js");

function fixture() {
  const rows = [{id:"own",brand:"workspace-a",name:"Own agent",format:"comparison",base:"geo_article",active:true}, {id:"other",brand:"workspace-b",name:"Other agent",format:"article",base:"geo_article",active:true}];
  const writes = [];
  const admin = { from(table) {
    let selected = table === "content_agents" ? rows : [];
    let mutation;
    const finish = (single) => {
      if (mutation) {
        writes.push({table, operation:mutation.kind, ids:selected.map(row=>row.id)});
        if(mutation.kind==="update") selected.forEach(row=>Object.assign(row,mutation.data));
        if(mutation.kind==="insert") selected=mutation.data;
      }
      return {data:single ? selected[0] || null : selected,error:null};
    };
    return {
      select(){return this;},order(){return this;},limit(){return this;},
      eq(key,value){selected=selected.filter(row=>row[key]===value);return this;},
      ilike(){throw new Error("Opaque workspace keys must not use pattern matching");},
      insert(data){mutation={kind:"insert",data};return this;},
      update(data){mutation={kind:"update",data};return this;},delete(){mutation={kind:"delete"};return this;},
      maybeSingle:async()=>finish(true),single:async()=>finish(true),
      then(resolve,reject){return Promise.resolve(finish(false)).then(resolve,reject);},
    };
  }};
  globalThis.customerRouteFixture={admin,context:{client:admin,user:{id:"user-a"},error:null,brands:[{brandKey:"workspace-a",display_name:"Italica",website:"https://italicatiles.com/",role:"owner"}]}};
  return {rows,writes};
}
const request=(method,body,path="agents")=>new Request(`https://app.example.test/api/customer/${path}?brand_key=workspace-a`,{method,headers:{"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});

test("customer agent reads are scoped and opening an empty list does not seed writes",async()=>{
  const {writes}=fixture();
  const response=await agents.GET(request("GET"));
  assert.equal(response.status,200);
  const data=await response.json();
  assert.deepEqual(data.agents.map(agent=>agent.id),["own"]);
  assert.ok(data.blocks.some(block=>block.slug==="draft"));
  assert.equal(writes.length,0);
});
test("agent creation uses the authorized workspace and cannot forge built-in status",async()=>{
  const {writes}=fixture();
  const response=await agents.POST(request("POST",{brand_key:"workspace-a",brand:"workspace-b",name:"Tile FAQ",format:"faq",is_builtin:true}));
  assert.equal(response.status,201);
  const {agent}=await response.json();
  assert.equal(agent.brand,"workspace-a");
  assert.equal(agent.is_builtin,false);
  assert.equal(writes.length,1);
});
test("customer cannot edit, delete or run an agent from another workspace",async()=>{
  const {writes}=fixture();
  const params={params:Promise.resolve({id:"other"})};
  assert.equal((await agentItem.PUT(request("PUT",{brand_key:"workspace-a",name:"Hijacked"}),params)).status,404);
  assert.equal((await agentItem.DELETE(request("DELETE"),params)).status,404);
  assert.equal((await content.POST(request("POST",{brand_key:"workspace-a",query:"Best tiles",agent_id:"other"},"content"))).status,404);
  assert.equal(writes.length,0);
});
test("agent update retains its workspace and validates crew pipeline order",async()=>{
  const {rows,writes}=fixture();
  const params={params:{id:"own"}};
  assert.equal((await agentItem.PUT(request("PUT",{brand_key:"workspace-a",name:"Edited",brand:"workspace-b",is_builtin:true}),params)).status,200);
  assert.equal(rows[0].brand,"workspace-a");
  assert.equal(rows[0].is_builtin,false);
  assert.equal((await agentItem.PUT(request("PUT",{brand_key:"workspace-a",pipeline:["review","draft"]}),params)).status,400);
  assert.equal(writes.length,1);
});
test("customer agent endpoints reject unauthenticated and cross-site mutations",async()=>{
  const {writes}=fixture();
  globalThis.customerRouteFixture.context.user=null;
  assert.equal((await agents.GET(request("GET"))).status,401);
  fixture();
  const req=new Request("https://app.example.test/api/customer/agents",{method:"POST",headers:{origin:"https://evil.example","Content-Type":"application/json"},body:JSON.stringify({brand_key:"workspace-a",name:"Unsafe"})});
  assert.equal((await agents.POST(req)).status,403);
  assert.equal(writes.length,0);
});
