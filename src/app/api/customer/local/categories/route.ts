import { listBusinessCategories } from "../../../../../server/local/listings.ts";
import { categoriesQuery } from "../../../../../server/local/local.contract.ts";
import { gate, jsonOk, parseQuery, respond, type LocalRouteDeps } from "../../../../../server/local/routeKit.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const query = parseQuery(request, categoriesQuery);
    await gate(request, query.brand_key, deps);
    return jsonOk(await listBusinessCategories({ query: query.q, limit: query.limit }, deps));
  });
}
