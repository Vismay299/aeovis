import { listFetches, startFetch } from "../../../../../lib/local/fetches.ts";
import { fetchesQuery, startFetchBody } from "../../../../../lib/local/local.contract.ts";
import { approve, gate, jsonOk, parseBody, parseQuery, respond, type LocalRouteDeps } from "../../../../../lib/local/routeKit.ts";

export const dynamic = "force-dynamic";
// Reviews and posts poll the provider inline for up to 20 seconds.
export const maxDuration = 60;

const ACTION_KEYS = {
  reviews: "local.reviews.collect",
  updates: "local.updates.collect",
  questions: "local.questions.collect",
} as const;

export async function POST(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, startFetchBody);
    const ws = await gate(request, body.brand_key, deps);
    const quoted: Record<string, unknown> = { businessId: body.businessId, depth: body.depth };
    if (body.kind === "reviews") {
      quoted.sortBy = body.sortBy;
      quoted.includeOtherSources = body.includeOtherSources ?? false;
    }
    const approvedMaxUsd = await approve(ACTION_KEYS[body.kind], ws, quoted, body.maxUsd, deps);
    const view = await startFetch(
      ws,
      {
        kind: body.kind,
        businessId: body.businessId,
        depth: body.depth,
        sortBy: body.sortBy,
        includeOtherSources: body.includeOtherSources,
        maxUsd: approvedMaxUsd,
        requestId: body.requestId,
      },
      deps,
    );
    return jsonOk(view, view.status === "processing" ? 202 : 200);
  });
}

export async function GET(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const query = parseQuery(request, fetchesQuery);
    const ws = await gate(request, query.brand_key, deps);
    const fetches = await listFetches(ws, { businessId: query.businessId, kind: query.kind, limit: query.limit }, deps);
    return jsonOk({ fetches });
  });
}
