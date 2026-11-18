import { handleReportRequest } from "@/server/reports/documentRoutes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /r/[reportId]: the stored report, served byte for byte under REPORT_CSP. */
export async function GET(
  request: Request,
  context: { params: Promise<{ reportId: string }> }
): Promise<Response> {
  const { reportId } = await context.params;
  return handleReportRequest(reportId, request);
}
