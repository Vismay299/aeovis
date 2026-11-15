import { estimatePriceTool } from "../own/pricing.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";

export const registrations:ToolRegistration[]=[
 defineRegistration({def:estimatePriceTool,area:"pricing",feature:null,effect:"read",approval:()=>({kind:"none"}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},summarize:(o:any)=>o?.blocked?String(o.blocked.message):"Estimated price: $"+Number(o?.totalUsd??0).toFixed(2)+" USD.",example:{input:{action:"questions.generate.run",input:{topic:"Example topic"}},output:{action:"questions.generate.run",currency:"USD",totalUsd:0.1,expectedUsd:0.1,units:[],lines:[],monthly:null,warnings:[],blocked:null,priceVersion:"v1",quotedAt:"2026-10-20T10:12:04.000Z",inputsHash:"a".repeat(64)}}}),
];
