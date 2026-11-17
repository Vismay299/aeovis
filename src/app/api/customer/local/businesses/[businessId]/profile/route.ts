import { businessNotFound } from "../../../../../../../server/local/businesses.ts";
import { businessIdParams, refreshProfileBody } from "../../../../../../../server/local/local.contract.ts";
import { refreshBusinessProfile } from "../../../../../../../server/local/profile.ts";
import {
  approve,
  gate,
  jsonOk,
  parseBody,
  parseParams,
  respond,
  type LocalRouteDeps,
  type RouteContext,
} from "../../../../../../../server/local/routeKit.ts";
import { localStoreFor } from "../../../../../../../server/local/store.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<{ businessId: string }>,
  deps?: LocalRouteDeps,
): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, refreshProfileBody);
    const { businessId } = await parseParams(context, businessIdParams);
    const ws = await gate(request, body.brand_key, deps);
    // The saved business supplies the identifier; a foreign or unknown id is a 404 before any quote.
    const business = await localStoreFor(ws, deps).getBusiness(ws.brandKey, businessId);
    if (!business) throw businessNotFound();
    const approvedMaxUsd = await approve(
      "local.profile.lookup",
      ws,
      { identifier: business.cid ? { cid: business.cid } : { placeId: business.place_id ?? undefined } },
      body.maxUsd,
      deps,
    );
    const profile = await refreshBusinessProfile(ws, businessId, { maxUsd: approvedMaxUsd, requestId: body.requestId }, deps);
    return jsonOk({ profile });
  });
}
