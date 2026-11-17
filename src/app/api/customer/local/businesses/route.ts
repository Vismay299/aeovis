import { listBusinesses, saveBusiness } from "../../../../../server/local/businesses.ts";
import { localBrandQuery, saveBusinessBody } from "../../../../../server/local/local.contract.ts";
import { gate, jsonOk, parseBody, parseQuery, respond, type LocalRouteDeps } from "../../../../../server/local/routeKit.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const query = parseQuery(request, localBrandQuery);
    const ws = await gate(request, query.brand_key, deps);
    return jsonOk({ businesses: await listBusinesses(ws, deps) });
  });
}

export async function POST(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, saveBusinessBody);
    const ws = await gate(request, body.brand_key, deps);
    const { brand_key: _brandKey, ...input } = body;
    return jsonOk({ business: await saveBusiness(ws, input, deps) }, 201);
  });
}
