import { handleSharedReportRequest } from "@/server/reports/documentRoutes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /s/[token]/raw: the shared document, framed by the wrapper page. */
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await context.params;
  return handleSharedReportRequest(token, request);
}
