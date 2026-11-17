import { ZodError } from "zod";
import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { toErrorResponse, readJsonBody, jsonOk, AppError } from "../../../../../shared/http/errors.ts";
import { quote } from "../../../../../shared/pricing/pricedActions.ts";
import "../../../../../shared/pricing/actions/index.ts";
import { priceEstimateBody } from "../../../../../shared/pricing/pricing.contract.ts";

export type EstimateRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  quote?: typeof quote;
  now?: () => Date;
};

export async function POST(request: Request, deps?: EstimateRouteDeps): Promise<Response> {
  try {
    const rawJson = await readJsonBody(request);
    const body = priceEstimateBody.parse(rawJson);

    const loadWorkspace = deps?.requireWorkspace ?? requireWorkspace;
    const workspace = await loadWorkspace(request, { brandKey: body.brand_key }, deps);

    const quoteFn = deps?.quote ?? quote;
    const now = deps?.now ? deps.now() : new Date();

    let result;
    try {
      result = await quoteFn(
        body.action,
        {
          brandKey: workspace.brandKey,
          admin: workspace.admin,
          env: process.env,
          now,
        },
        body.input,
      );
    } catch (err) {
      if (err instanceof AppError || err instanceof ZodError) throw err;
      throw new AppError(503, "pricing_unavailable", "Prices could not be calculated. Please retry.", {
        cause: err,
      });
    }

    return jsonOk(result);
  } catch (err: unknown) {
    return toErrorResponse(err);
  }
}
