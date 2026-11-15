import { listQuestionsTool, addQuestionsTool } from "../../questions/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";

export const registrations:ToolRegistration[]=[
 defineRegistration({def:listQuestionsTool as never,area:"questions",feature:"question_curation",effect:"read",approval:()=>({kind:"none"}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},summarize:(o:any,i:any)=>(o?.questions?.length??0)+" questions ("+(i?.status??"active")+"); panel version "+(o?.approvedVersion??"none")+(o?.dirty?", unapproved changes":"")+".",link:()=>({path:"/portal/measurement",label:"Questions"}),example:{input:{status:"active"},output:{questions:[],approvedVersion:null,dirty:false}}}),
 defineRegistration({def:addQuestionsTool as never,area:"questions",feature:"question_curation",effect:"write",approval:()=>({kind:"none"}),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false},summarize:(o:any)=>"Added "+(o?.added??0)+", revived "+(o?.revived??0)+", skipped "+(o?.skipped??0)+". Not approved yet.",link:()=>({path:"/portal/measurement",label:"Questions"}),example:{input:{questions:[{text:"Which products fit this need?"}]},output:{added:0,revived:0,skipped:1}}}),
];
