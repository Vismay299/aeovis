import {NextResponse} from 'next/server';
import {getContentItem} from '@/lib/db/content';
import {getScansForBrand} from '@/lib/db';
import {normalizeScanRows} from '@/lib/content/steps/shared';
import {repairWorkflowStore} from '@/lib/db/repairWorkflow';
import {comparePublicationObservations} from '@/lib/repairs/publicationObservation';
export const dynamic='force-dynamic';
export const revalidate=0;
export async function GET(request,{params}){
 const {id}=await params;
 try{
  const item=await getContentItem(id);if(!item)return NextResponse.json({detail:'Item not found.'},{status:404});
  if(item.playbook!=='geo_article')return NextResponse.json({applicable:false});
  const publications=await repairWorkflowStore().list(item.brand,'publication');
  const publication=publications.filter(p=>p.payload.item_id===id && p.payload.content_hash===item.approved_hash).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0]?.payload;
  const scans=publication?await getScansForBrand(item.brand):[];
  return NextResponse.json(comparePublicationObservations({publication,scans,rowsForScan:normalizeScanRows}),{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({detail:'Publication observations are unavailable.'},{status:503});}
}
