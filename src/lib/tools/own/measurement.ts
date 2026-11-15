import { z } from "zod";
import type { ToolDefinition, ToolHandlerContext } from "../types.ts";
import { AppError } from "../../http/appError.ts";
import type { Workspace } from "../../workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../features/flags.ts";
import { getCustomerSchedule } from "../../schedules/customerSchedule.ts";
import { resolveScanEngineNames } from "../../pricing/actions/scanRun.ts";
import { listQuestionsTool } from "../../questions/tools.ts";

const input=z.strictObject({});
const questionPanel=listQuestionsTool.output;
const output=z.looseObject({
 panel:z.looseObject({approvedVersion:z.number().nullable(),dirty:z.boolean().nullable(),active:z.number(),branded:z.number()}),
 schedule:z.looseObject({}).nullable(),
 latestScans:z.array(z.looseObject({scanId:z.string().nullable(),jobId:z.string(),status:z.string(),createdAt:z.string().nullable(),finishedAt:z.string().nullable(),visibilityPct:z.number().nullable(),answered:z.number().nullable(),planned:z.number().nullable()})),
 enginesConfigured:z.array(z.string()),
});
type Row=Record<string,any>;
type Deps={
 listQuestions?:(ctx:ToolHandlerContext,input:{status:"active"})=>Promise<unknown>;
 enabled?:(name:"customer_scheduling",brandKey:string)=>Promise<boolean>;
 schedule?:(ctx:ToolHandlerContext)=>Promise<unknown>;
};
async function read<T>(q:unknown):Promise<T>{const r=await q as {data:T,error:unknown};if(r.error)throw r.error;return r.data;}
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;

export function createMeasurementStatusTool(deps:Deps={}):ToolDefinition {
 return {name:"get_measurement_status",description:"Summarize the active question panel, schedule, and latest visibility scans.",input,output,
  handler:async(ctx,raw)=>{
   input.parse(raw);
   const panelRaw=deps.listQuestions
    ? await deps.listQuestions(ctx,{status:"active"})
    : await (listQuestionsTool.handler as (ctx:ToolHandlerContext,input:unknown)=>Promise<unknown>)(ctx,{status:"active"});
   const panel=questionPanel.parse(panelRaw) as {questions:Row[];approvedVersion:number|null;dirty:boolean};
   const jobs=await read<Row[]>(ctx.admin.from("scan_jobs").select("id,brand_key,status,created_at,finished_at,scan_id,origin_job_id").eq("brand_key",ctx.brand.brandKey).order("created_at",{ascending:false}).limit(5));
   const jobRows=Array.isArray(jobs)?jobs:[];
   const origins=[...new Set(jobRows.map(j=>j.origin_job_id).filter((x):x is string=>typeof x==="string"))];
   const scans=origins.length?await read<Row[]>(ctx.admin.from("scans").select("id,origin_job_id,visibility_pct,prompts_tracked,prompts_mentioned,prompts_answered").eq("brand_key",ctx.brand.brandKey).in("origin_job_id",origins)):[];
   const byOrigin=new Map((Array.isArray(scans)?scans:[]).map(s=>[String(s.origin_job_id),s]));
   let schedule:unknown=null;
   const isOn=deps.enabled??(async(name,brandKey)=>isFeatureEnabled(name,brandKey));
   if(await isOn("customer_scheduling",ctx.brand.brandKey)){
    schedule=deps.schedule?await deps.schedule(ctx):await getCustomerSchedule(ctx.admin,{user:ctx.user,brandKey:ctx.brand.brandKey,brand:ctx.brand,role:ctx.role,admin:ctx.admin} as Workspace);
   }
   const scheduleRecord=schedule&&typeof schedule==="object"?schedule as Row:null;
   const enginesConfigured=resolveScanEngineNames(scheduleRecord,process.env).configured;
   return output.parse({
    panel:{approvedVersion:panel.approvedVersion,dirty:panel.dirty,active:panel.questions.length,branded:panel.questions.filter(q=>q.branded).length},
    schedule,
    latestScans:jobRows.map(job=>{const scan=byOrigin.get(String(job.id))??byOrigin.get(String(job.origin_job_id));return {
      scanId:typeof scan?.id==="string"?scan.id:typeof job.scan_id==="string"?job.scan_id:null,
      jobId:String(job.id),status:String(job.status),createdAt:typeof job.created_at==="string"?job.created_at:null,
      finishedAt:typeof job.finished_at==="string"?job.finished_at:null,
      visibilityPct:num(scan?.visibility_pct),answered:num(scan?.prompts_answered??scan?.prompts_mentioned),
      planned:num(scan?.prompts_tracked),
    };}),
    enginesConfigured,
   });
  }
 };
}
export const getMeasurementStatusTool=createMeasurementStatusTool();
