import { handleReportSocialImage } from "@/server/reports/documentRoutes";
import { renderReportSocialImage } from "@/server/reports/ogImage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /s/[token]/og.png: the link preview image for a shared report. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await context.params;
  return handleReportSocialImage(token, { render: renderReportSocialImage });
}
