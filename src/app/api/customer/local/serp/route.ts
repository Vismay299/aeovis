import { getLocalSerpResults } from "../../../../../lib/local/localSerp.ts";
import { serpBody } from "../../../../../lib/local/local.contract.ts";
import { approve, gate, jsonOk, parseBody, respond, type LocalRouteDeps } from "../../../../../lib/local/routeKit.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, serpBody);
    const ws = await gate(request, body.brand_key, deps);
    const { brand_key: _brandKey, maxUsd, requestId, ...input } = body;
    const approvedMaxUsd = await approve("local.serp.search", ws, input, maxUsd, deps);
    const result = await getLocalSerpResults(ws, { ...input, maxUsd: approvedMaxUsd, requestId }, deps);
    return jsonOk(result);
  });
}
