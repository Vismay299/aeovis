import { AppError } from "../../../../../lib/http/appError.ts";
import { listGrids, startGrid } from "../../../../../lib/local/grid.ts";
import { gridsQuery, startGridBody } from "../../../../../lib/local/local.contract.ts";
import { approve, gate, jsonOk, parseBody, parseQuery, respond, type LocalRouteDeps } from "../../../../../lib/local/routeKit.ts";

export const dynamic = "force-dynamic";
// A grid collects its map searches inline for up to 20 seconds.
export const maxDuration = 60;

export async function POST(request: Request, _ctx?: unknown, deps?: LocalRouteDeps): Promise<Response> {
  return respond(async () => {
    const body = await parseBody(request, startGridBody);
    const ws = await gate(request, body.brand_key, deps);
    const { target } = body;
    if (!target.businessId && !target.cid && !target.placeId && !target.name) {
      throw new AppError(400, "grid_target_required", "Choose the business to find in each search.");
    }
    // The grid always needs an approved price (F09 requireApproval).
    const approvedMaxUsd = await approve(
      "local.grid.run",
      ws,
      {
        keyword: body.keyword,
        center: body.center,
        gridSize: body.gridSize,
        spacingKm: body.spacingKm,
        device: body.device,
        zoom: body.zoom,
        languageCode: body.languageCode,
      },
      body.maxUsd,
      deps,
    );
    const view = await startGrid(
      ws,
      {
        keyword: body.keyword,
        center: body.center,
        gridSize: body.gridSize,
        spacingKm: body.spacingKm,
        device: body.device,
        zoom: body.zoom,
        languageCode: body.languageCode,
        target,
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
    const query = parseQuery(request, gridsQuery);
    const ws = await gate(request, query.brand_key, deps);
    return jsonOk({ grids: await listGrids(ws, query.limit, deps) });
  });
}
