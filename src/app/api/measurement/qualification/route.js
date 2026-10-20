import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { prepareEvidenceQualification, cleanupEvidenceQualification, verifyEvidenceRetention, withdrawQaRedaction } from "@/lib/ops/evidenceQualification";
export const dynamic="force-dynamic";
export const maxDuration=120;

// Operator-only, like the other /api/measurement routes. Fixture credentials are
// returned only to that authenticated caller, never persisted in evidence/logs.
export async function POST(request) {
  const origin=request.headers.get("origin");
  if((origin && origin!==new URL(request.url).origin) || request.headers.get("sec-fetch-site")==="cross-site")return NextResponse.json({error:"Cross-site qualification refused"},{status:403});
  const input=await request.json().catch(()=>null),admin=getSupabaseAdmin();
  if(!admin)return NextResponse.json({error:"Qualification storage unavailable"},{status:503});
  if(!input || !["prepare","cleanup","verify_retention","withdraw_redaction"].includes(input.action))return NextResponse.json({error:"Choose a QA preparation, retention check, privacy retraction or cleanup action"},{status:400});
  try{
    const result=input.action==="withdraw_redaction" ? await withdrawQaRedaction(admin,input.observation_ids) : input.action==="prepare" ? await prepareEvidenceQualification(admin,input.run_id) : input.action==="verify_retention" ? await verifyEvidenceRetention(admin,input.run_id) : await cleanupEvidenceQualification(admin,input.run_id,input.user_ids);
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store","Pragma":"no-cache"}});
  }catch{return NextResponse.json({error:"Qualification did not complete; inspect and clean the named QA run before retrying"},{status:503});}
}
