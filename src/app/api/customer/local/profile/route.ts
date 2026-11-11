import { profileBody } from "../../../../../lib/local/local.contract.ts";
import { lookupBusinessProfile } from "../../../../../lib/local/profile.ts";
import { approve, gate, jsonOk, parseBody, respond, type LocalRouteDeps } from "../../../../../lib/local/routeKit.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, profileBody);
    const ws = await gate(request, body.brand_key, deps);
    const approvedMaxUsd = await approve(
      "local.profile.lookup",
      ws,
      { identifier: body.identifier, near: body.near, locationCode: body.locationCode },
      body.maxUsd,
      deps,
    );
    const result = await lookupBusinessProfile(
      ws,
      {
        identifier: body.identifier,
        near: body.near,
        locationCode: body.locationCode,
        languageCode: body.languageCode,
        save: body.save,
        maxUsd: approvedMaxUsd,
        requestId: body.requestId,
      },
      deps,
    );
    return jsonOk(result);
  });
}
