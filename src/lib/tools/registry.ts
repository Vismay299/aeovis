import { isFeatureEnabled } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import type { ToolRegistration } from "./types.ts";
import { registrations as memory } from "./catalog/memory.ts";
import { registrations as questions } from "./catalog/questions.ts";
import { registrations as visibility } from "./catalog/visibility.ts";
import { registrations as pricing } from "./catalog/pricing.ts";

export const TOOL_REGISTRY:readonly ToolRegistration[]=[...memory,...questions,...visibility,...pricing].sort((a,b)=>a.def.name.localeCompare(b.def.name));
const byName=new Map(TOOL_REGISTRY.map((r)=>[r.def.name,r]));
export function getTool(name:string):ToolRegistration|null{return byName.get(name)??null;}
export function filterOwnerTools(registrations:readonly ToolRegistration[],role:"owner"|"member"):ToolRegistration[]{return role==="owner"?[...registrations]:registrations.filter((registration)=>!registration.ownerOnly);}
export async function availableTools(ctx:{brandKey:string;role:"owner"|"member"},deps:{isFeatureEnabled?:typeof isFeatureEnabled}={}):Promise<ToolRegistration[]>{
 const enabled=deps.isFeatureEnabled??isFeatureEnabled;
 const featureNames=[...new Set(TOOL_REGISTRY.map(r=>r.feature).filter((x):x is FeatureName=>x!==null))];
 const flags=new Map<FeatureName,boolean>(await Promise.all(featureNames.map(async(feature)=>{
  try{return [feature,await enabled(feature,ctx.brandKey)] as const;}catch{return [feature,false] as const;}
 })));
 return filterOwnerTools(TOOL_REGISTRY.filter(registration=>registration.feature===null||flags.get(registration.feature)===true),ctx.role);
}
