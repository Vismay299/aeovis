import { collectGrid } from "../../../../../../server/local/grid.ts";
import { gridIdParams, localBrandQuery } from "../../../../../../server/local/local.contract.ts";
import {
  gate,
  jsonOk,
  parseParams,
  parseQuery,
  respond,
  type LocalRouteDeps,
  type RouteContext,
} from "../../../../../../server/local/routeKit.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Collection is free: a processing grid is read from the provider at most once per 4 seconds.
export async function GET(
  request: Request,
  context: RouteContext<{ gridId: string }>,
  deps?: LocalRouteDeps,
): Promise<Response> {
  return respond(async () => {
    const query = parseQuery(request, localBrandQuery);
    const { gridId } = await parseParams(context, gridIdParams);
    const ws = await gate(request, query.brand_key, deps);
    return jsonOk(await collectGrid(ws, gridId, deps));
  });
}
