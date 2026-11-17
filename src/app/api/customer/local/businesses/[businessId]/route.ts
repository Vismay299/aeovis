import { removeBusiness, updateBusinessRole } from "../../../../../../server/local/businesses.ts";
import { businessIdParams, localBrandQuery, updateBusinessBody } from "../../../../../../server/local/local.contract.ts";
import {
  gate,
  jsonOk,
  parseBody,
  parseParams,
  parseQuery,
  respond,
  type LocalRouteDeps,
  type RouteContext,
} from "../../../../../../server/local/routeKit.ts";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<{ businessId: string }>;

export async function PATCH(request: Request, context: Ctx, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, updateBusinessBody);
    const { businessId } = await parseParams(context, businessIdParams);
    const ws = await gate(request, body.brand_key, deps);
    return jsonOk({ business: await updateBusinessRole(ws, businessId, body.role, deps) });
  });
}

export async function DELETE(request: Request, context: Ctx, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const query = parseQuery(request, localBrandQuery);
    const { businessId } = await parseParams(context, businessIdParams);
    const ws = await gate(request, query.brand_key, deps);
    await removeBusiness(ws, businessId, deps);
    return jsonOk({ removed: true });
  });
}
