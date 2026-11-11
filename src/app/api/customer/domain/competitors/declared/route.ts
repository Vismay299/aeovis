import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../lib/workspace/requireWorkspace.ts";
import { domainBrandQuery } from "../../../../../../lib/domain/domain.contract.ts";
import { declaredCompetitors as defaultDeclaredCompetitors } from "../../../../../../lib/projectContext/service.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type DomainCompetitorsDeclaredRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  declaredCompetitors?: typeof defaultDeclaredCompetitors;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function queryBrandKey(request: Request): string | undefined {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = domainBrandQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Check the query and try again.");
  }
  return parsed.data.brand_key;
}

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: DomainCompetitorsDeclaredRouteDeps,
): Promise<Response> {
  try {
    const brandKey = queryBrandKey(request);
    const workspace = await requireWorkspace(request, { brandKey }, deps);

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const memoryEnabled = await checkFlag("project_memory", workspace.brandKey);

    if (!memoryEnabled) {
      return json({
        available: false,
        competitors: [],
      });
    }

    const declaredFn = deps?.declaredCompetitors ?? defaultDeclaredCompetitors;
    const comps = await declaredFn(workspace.admin, workspace.brandKey);

    const ownHost = (workspace.brand?.website_host || workspace.brand?.website || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];

    return json({
      available: true,
      competitors: comps.map((c) => ({
        domain: c.domain,
        name: c.name ?? null,
      })),
      ownHost,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
