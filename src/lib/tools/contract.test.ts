import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { getPricedAction } from "../pricing/pricedActions.ts";
import { TOOL_REGISTRY } from "./registry.ts";

function visit(value:unknown,check:(node:Record<string,unknown>)=>void):void{
 if(!value||typeof value!=="object")return;
 const node=value as Record<string,unknown>;check(node);
 if(Array.isArray(value)){for(const child of value)visit(child,check);return;}
 for(const child of Object.values(node))visit(child,check);
}
test("registered input schemas are JSON-schema representable, closed at root, and parse examples",()=>{
 for(const reg of TOOL_REGISTRY){
  const schema=z.toJSONSchema(reg.def.input,{io:"input"}) as Record<string,unknown>;
  assert.equal(schema.additionalProperties,false,reg.def.name+" input root must be closed");
  assert.doesNotThrow(()=>reg.def.input.parse(reg.example.input),reg.def.name+" input example");
 }
});
test("registered output schemas have no closed paths and parse examples",()=>{
 for(const reg of TOOL_REGISTRY){
  const schema=z.toJSONSchema(reg.def.output,{io:"output"});
  visit(schema,node=>assert.notEqual(node.additionalProperties,false,reg.def.name+" output path must stay open"));
  assert.doesNotThrow(()=>reg.def.output.parse(reg.example.output),reg.def.name+" output example");
 }
});
test("paid registrations declare maxUsd and map their example to a priced action",async()=>{
 for(const reg of TOOL_REGISTRY.filter(item=>item.effect==="paid")){
  const input=reg.def.input.parse(reg.example.input) as Record<string,unknown>;
  assert.equal(typeof input.maxUsd,"number",reg.def.name+" requires maxUsd");
  const decision=await reg.approval({} as never,input);
  assert.equal(decision.kind,"price",reg.def.name+" requires price approval");
  if(decision.kind==="price"){
   const action=getPricedAction(decision.action);
   assert.ok(action,reg.def.name+" priced action must be registered");
   assert.doesNotThrow(()=>action.input.parse(decision.quoteInput),reg.def.name+" quote input");
  }
 }
});
test("registrations whose input declares maxUsd are paid and map to a priced action",async()=>{
 let checked=0;
 for(const reg of TOOL_REGISTRY){
  const schema=z.toJSONSchema(reg.def.input,{io:"input"}) as {properties?:Record<string,unknown>};
  if(!schema.properties||!("maxUsd" in schema.properties))continue;
  checked+=1;
  assert.equal(reg.effect,"paid",reg.def.name+" declares maxUsd and must be paid");
  const input=reg.def.input.parse(reg.example.input) as Record<string,unknown>;
  const decision=await reg.approval({} as never,input);
  assert.equal(decision.kind,"price",reg.def.name+" must map maxUsd to a price approval");
  if(decision.kind!=="price")continue;
  const action=getPricedAction(decision.action);
  assert.ok(action,reg.def.name+" priced action must be registered");
  if(!action)continue;
  assert.doesNotThrow(()=>action.input.parse(decision.quoteInput),reg.def.name+" quote input");
 }
 assert.ok(checked>0,"the registry must contain at least one maxUsd tool");
});
