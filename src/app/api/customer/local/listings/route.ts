import { searchLocalBusinesses } from "../../../../../server/local/listings.ts";
import { listingsBody } from "../../../../../server/local/local.contract.ts";
import { approve, gate, jsonOk, parseBody, respond, type LocalRouteDeps } from "../../../../../server/local/routeKit.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, listingsBody);
    const ws = await gate(request, body.brand_key, deps);
    const { brand_key: _brandKey, maxUsd, requestId, ...input } = body;
    const approvedMaxUsd = await approve("local.listings.search", ws, input, maxUsd, deps);
    const result = await searchLocalBusinesses(ws, { ...input, maxUsd: approvedMaxUsd, requestId }, deps);
    return jsonOk(result);
  });
}
