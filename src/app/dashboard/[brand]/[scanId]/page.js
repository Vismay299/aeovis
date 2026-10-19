"use client";
import {useParams} from 'next/navigation';
import StoredReportPage from '@/components/dashboard/StoredReportPage';
export default function BrandScanDashboardPage(){
 const params=useParams();const scanId=params?.scanId || '';
 return <StoredReportPage url={scanId?`/api/scans/by-id/${encodeURIComponent(scanId)}`:null} scanId={scanId || null}/>;
}
