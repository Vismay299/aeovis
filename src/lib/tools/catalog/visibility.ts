import { defineRegistration, type ToolRegistration } from "../types.ts";
import { getMeasurementStatusTool } from "../own/measurement.ts";
import { getScanAnswerTool,getScanReportTool,getScanSourcesTool,getScanStatusTool,listScansTool } from "../own/scans.ts";
import { getQuestionAnswerTool,getQuestionHistoryTool } from "../own/questionsHistory.ts";

const qid="0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182";
const aid="6a1f0000-0000-4000-8000-000000000001";
const sid="9e8d0000-0000-4000-8000-000000000001";
const execution={answerId:aid,source:"scan",engine:"chatgpt",engineLabel:"ChatGPT",collectedAt:"2026-10-20T10:12:04.000Z",trigger:"manual",status:"answered",ownMentioned:false,ownCited:false,askedText:"sample question",scanId:sid,exploreRunId:null,method:"model_api",quality:"measured"};
const ann={readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true};
const registration=(def:any,example:any,summarize:(o:any,i:any)=>string,path?:(o:any,i:any)=>string,extra:Partial<ToolRegistration>={})=>defineRegistration({def,area:"visibility",feature:null,effect:"read",approval:()=>({kind:"none"}),annotations:ann,summarize,link:path?(o:any,i:any)=>({path:path(o,i),label:"View details"}):undefined,...extra,example} as ToolRegistration);
export const registrations:ToolRegistration[]=[
 registration(getMeasurementStatusTool,{input:{},output:{panel:{approvedVersion:null,dirty:false,active:0,branded:0},schedule:null,latestScans:[],enginesConfigured:[]}},o=>"Measurement: "+(o?.panel?.active??0)+" active questions; "+(o?.latestScans?.length??0)+" recent scans.",()=>"/portal/measurement"),
 registration(listScansTool,{input:{limit:10},output:{scans:[],totalCount:0}},o=>(o?.scans?.length??0)+" recent scans.",()=>"/portal/scans"),
 registration(getScanReportTool,{input:{scanId:sid},output:{scan:{scanId:sid,scannedAt:null,visibilityPct:null,engines:null,competitors:[]},rows:[],totalCount:0,coverage:{planned:null,answered:0,notAnswered:0,failed:0}}},o=>"Scan report: "+(o?.rows?.length??0)+" answers.",o=>"/portal/scans/"+(o?.scan?.scanId??"")),
 registration(getScanAnswerTool,{input:{resultId:aid},output:{resultId:aid,scanId:sid,question:"sample question",engine:"chatgpt",answered:true,mentioned:false,cited:false,answer:"A sample answer.",truncated:false}},o=>"Answer for "+(o?.question??"scan question")+".",o=>"/portal/scans/"+(o?.scanId??""),{untrustedPaths:["answer"]}),
 registration(getScanSourcesTool,{input:{scanId:sid},output:{sources:[],totalCount:0,note:"Counts are answers in this scan that cited the domain."}},o=>(o?.sources?.length??0)+" cited domains.",(o,i)=>"/portal/scans/"+(i?.scanId??""),{untrustedPaths:["sources[*].exampleUrl"]}),
 registration(getScanStatusTool,{input:{jobId:sid},output:{jobId:sid,status:"completed",progressPct:100,scanId:sid}},o=>"Scan job "+(o?.status??"unknown")+".",()=>"/portal/scans",{waitForProgress:{statusPath:"status",runningValues:["pending","running"],progressPath:"progressPct",budgetMs:45_000}}),
 registration(getQuestionHistoryTool,{input:{questionId:qid},output:{question:{id:qid,text:"sample question",topic:null,status:"active",branded:false,origin:"manual",replacedBy:null,replaces:[]},range:{from:null,to:null},executions:[],summary:[],coverage:{total:0,answered:0,noAnswer:0,failed:0,explore:0,legacy:0},truncated:false,latestScanId:null}},o=>(o?.coverage?.total??0)+" recorded question answers.",o=>"/portal/questions/"+(o?.question?.id??qid)),
 registration(getQuestionAnswerTool,{input:{questionId:qid,answerId:aid},output:{execution,text:null,markdown:null,truncated:false,citations:[],brands:[],provenance:{method:"unknown",methodLabel:"Unknown method",gateway:null,requestedModel:null,returnedModel:null,requestedLocation:null,searchUsed:"unknown"},evidence:{state:"none",captures:[]},error:null}},o=>"Answer for "+(o?.execution?.engineLabel??"question")+".",(_o,i)=>"/portal/questions/"+i.questionId,{untrustedPaths:["text","markdown"]}),
];
