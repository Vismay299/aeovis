// Shared plumbing for the /api/customer/local routes: body and query parsing,
// workspace + flag gate, approved-price step and error mapping. Each route file
// stays a thin handler over the services in this folder.

import type { ZodType, z } from "zod";
import { isFeatureEnabled } from "../features/flags.ts";
import { AppError, jsonOk, readJsonBody, toErrorResponse } from "../../shared/http/errors.ts";
import "../../shared/pricing/actions/index.ts";
import { requireApprovedPrice, type PricingContext } from "../../shared/pricing/pricedActions.ts";
import { toResearchError } from "../research/providerErrors.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
  type Workspace,
} from "../workspace/requireWorkspace.ts";
import { LOCAL_UNAVAILABLE_MESSAGE, type LocalDeps } from "./store.ts";

export const FEATURE_UNAVAILABLE_MESSAGE = "This page is not available for your workspace yet.";

export type LocalRouteDeps = RequireWorkspaceDeps &
  LocalDeps & {
    requireWorkspace?: typeof requireWorkspace;
    isFeatureEnabled?: typeof isFeatureEnabled;
    requireApprovedPrice?: typeof requireApprovedPrice;
  };

export type RouteContext<P extends Record<string, string> = Record<string, string>> = {
  params: Promise<P>;
};

function invalid(error: unknown): AppError {
  return new AppError(400, "invalid_request", "Check request fields and try again.", { cause: error });
}

export async function parseBody<S extends ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const raw = await readJsonBody(request);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

export function parseQuery<S extends ZodType>(request: Request, schema: S): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

export async function parseParams<S extends ZodType>(context: RouteContext | undefined, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await context?.params);
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

/** Workspace membership plus the `local_seo` flag. A flag-off workspace gets 404. */
export async function gate(request: Request, brandKey: string | undefined, deps?: LocalRouteDeps): Promise<Workspace> {
  const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey }, deps);
  if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("local_seo", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", FEATURE_UNAVAILABLE_MESSAGE);
  }
  return workspace;
}

/** F09 approval step: returns the maxUsd to pass to the metered call. */
export async function approve(
  key: string,
  ws: Workspace,
  input: Record<string, unknown>,
  maxUsd: number | undefined,
  deps?: LocalRouteDeps,
): Promise<number> {
  const ctx: PricingContext = { brandKey: ws.brandKey, admin: ws.admin, env: process.env, now: new Date() };
  const approved = await (deps?.requireApprovedPrice ?? requireApprovedPrice)(key, ctx, input, maxUsd);
  return approved.approvedMaxUsd;
}

/** Wraps a handler: provider failures map to local_unavailable, everything else through toErrorResponse. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    return toErrorResponse(
      toResearchError(err, { unavailableCode: "local_unavailable", unavailableMessage: LOCAL_UNAVAILABLE_MESSAGE }),
    );
  }
}

export { jsonOk };
