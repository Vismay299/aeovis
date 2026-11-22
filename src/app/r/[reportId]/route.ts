import { handleReportRequest } from "@/server/reports/documentRoutes";
import { isSampleReportId, sampleReportHtml } from "@/server/reports/sampleReportDocument";
import { reportDocumentResponse } from "@/shared/report-sandbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /r/[reportId]: the stored report, served byte for byte under REPORT_CSP. */
export async function GET(
  request: Request,
  context: { params: Promise<{ reportId: string }> }
): Promise<Response> {
  const { reportId } = await context.params;
  // The sample workspace's fictional reports, under the same sandbox headers.
  if (isSampleReportId(reportId)) {
    const print = new URL(request.url).searchParams.get("print") === "1";
    return reportDocumentResponse(sampleReportHtml(reportId), { print, cacheControl: "public, max-age=300", noindex: true });
  }
  return handleReportRequest(reportId, request);
}
