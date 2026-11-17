import { handleSharePage } from "@/server/reports/sharePage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /s/[token]: the static wrapper page framing the shared document. */
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await context.params;
  return handleSharePage(token, request);
}
