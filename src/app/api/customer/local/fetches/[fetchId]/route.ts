import { collectFetch } from "../../../../../../lib/local/fetches.ts";
import { fetchIdParams, localBrandQuery } from "../../../../../../lib/local/local.contract.ts";
import {
  gate,
  jsonOk,
  parseParams,
  parseQuery,
  respond,
  type LocalRouteDeps,
  type RouteContext,
} from "../../../../../../lib/local/routeKit.ts";

export const dynamic = "force-dynamic";

// Collection is free: a processing fetch is read from the provider at most once per 4 seconds.
export async function GET(
  request: Request,
  context: RouteContext<{ fetchId: string }>,
  deps?: LocalRouteDeps,
): Promise<Response> {
  return respond(async () => {
    const query = parseQuery(request, localBrandQuery);
    const { fetchId } = await parseParams(context, fetchIdParams);
    const ws = await gate(request, query.brand_key, deps);
    return jsonOk(await collectFetch(ws, fetchId, deps));
  });
}
