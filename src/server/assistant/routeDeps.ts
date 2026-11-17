import type { z } from "zod";
import { AppError } from "../../shared/http/appError.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
  type Workspace,
} from "../workspace/requireWorkspace.ts";

export const ASSISTANT_FEATURE_OFF = "This page is not available for your workspace yet.";

export type AssistantRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
};

export function queryObject(request: Request): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  return raw;
}

export function brandKeyFrom(request: Request, schema: z.ZodType<{ brand_key?: string }>): string | undefined {
  const parsed = schema.safeParse(queryObject(request));
  if (!parsed.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
  return parsed.data.brand_key;
}

export function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * §6.5 order: requireWorkspace, then the assistant flag. Every assistant route
 * is hidden with 404 (never 403) when the flag is off.
 */
export async function requireAssistantWorkspace(
  request: Request,
  brandKey: string | undefined,
  deps?: AssistantRouteDeps,
): Promise<Workspace> {
  const workspace = await requireWorkspace(request, { brandKey }, deps);
  const flag = deps?.isFeatureEnabled ?? isFeatureEnabled;
  if (!(await flag("assistant", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", ASSISTANT_FEATURE_OFF);
  }
  return workspace;
}

export async function sessionParam(context: {
  params: Promise<{ sessionId: string }> | { sessionId: string };
}): Promise<string> {
  const { sessionId } = await context.params;
  if (!sessionId || sessionId.length > 64) {
    throw new AppError(404, "session_not_found", "This chat was archived or does not exist.");
  }
  return sessionId;
}

export async function approvalParam(context: {
  params: Promise<{ approvalId: string }> | { approvalId: string };
}): Promise<string> {
  const { approvalId } = await context.params;
  if (!approvalId || approvalId.length > 64) {
    throw new AppError(404, "approval_not_found", "This approval does not exist.");
  }
  return approvalId;
}
