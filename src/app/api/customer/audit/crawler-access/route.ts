import { ZodError } from "zod";
import { requireWorkspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps, Workspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError, readJsonBody, toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  crawlerAccessBody,
  crawlerAccessQuery,
} from "../../../../../lib/audit/siteAudit.contract.ts";
import {
  listCrawlerCredentials,
  saveCrawlerCredential,
  type CrawlerAccessProblem,
} from "../../../../../lib/audit/crawlerAccess.ts";

export const dynamic = "force-dynamic";

const FEATURE_OFF = "This page is not available for your workspace yet.";
const FEATURE_DISABLED = "This feature is not enabled for your workspace.";
const OWNER_REQUIRED = "Only the workspace owner can manage Shopify crawler access.";

export type CrawlerAccessRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  listCrawlerCredentials?: typeof listCrawlerCredentials;
  saveCrawlerCredential?: typeof saveCrawlerCredential;
  env?: Record<string, string | undefined>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errors(err: unknown): Response {
  if (err instanceof AppError || err instanceof ZodError) return toErrorResponse(err);
  return toErrorResponse(
    new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", {
      cause: err,
    }),
  );
}

async function authorize(
  request: Request,
  brandKey: string | undefined,
  deps?: CrawlerAccessRouteDeps,
): Promise<Workspace> {
  const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
    request,
    { brandKey },
    deps,
  );
  const enabled = deps?.isFeatureEnabled ?? isFeatureEnabled;
  if (!(await enabled("site_audit", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", FEATURE_OFF);
  }
  if (!(await enabled("site_audit_crawler_access", workspace.brandKey))) {
    throw new AppError(403, "feature_disabled", FEATURE_DISABLED);
  }
  if (workspace.role !== "owner") {
    throw new AppError(403, "owner_required", OWNER_REQUIRED);
  }
  return workspace;
}

function problemResponse(problem: CrawlerAccessProblem): Response {
  if (problem.reason === "invalid_host") {
    return errors(
      new AppError(422, "invalid_host", "Enter a store domain, for example shop.example.com."),
    );
  }
  if (problem.reason === "audit_host_not_owned") {
    return errors(
      new AppError(
        422,
        "audit_host_not_owned",
        `Site audits run on your workspace website (${problem.workspaceHost}) and its subdomains.`,
      ),
    );
  }
  if (problem.reason === "wrong_domain") {
    return errors(
      new AppError(
        422,
        "signature_wrong_domain",
        `This signature was made for ${problem.signedHost}. Create one for ${problem.host} in Shopify.`,
      ),
    );
  }
  return errors(
    new AppError(
      422,
      "signature_invalid",
      "This doesn't look like a complete Shopify crawler signature. Copy both values again.",
    ),
  );
}

export async function GET(
  request: Request,
  _context?: unknown,
  deps?: CrawlerAccessRouteDeps,
): Promise<Response> {
  try {
    const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = crawlerAccessQuery.parse(raw);
    const workspace = await authorize(request, input.brand_key, deps);
    const credentials = await (deps?.listCrawlerCredentials ?? listCrawlerCredentials)(
      workspace.admin,
      workspace.brandKey,
      { env: deps?.env },
    );
    return json({ credentials });
  } catch (err) {
    return errors(err);
  }
}

export async function POST(
  request: Request,
  _context?: unknown,
  deps?: CrawlerAccessRouteDeps,
): Promise<Response> {
  try {
    const body = crawlerAccessBody.parse(await readJsonBody(request));
    const workspace = await authorize(request, body.brand_key, deps);
    const result = await (deps?.saveCrawlerCredential ?? saveCrawlerCredential)(
      workspace.admin,
      {
        brandKey: workspace.brandKey,
        userId: workspace.user.id,
        host: body.host,
        signatureInput: body.signatureInput,
        signature: body.signature,
        workspaceHost: workspace.brand.website_host,
      },
      { env: deps?.env },
    );
    if ("problem" in result) return problemResponse(result.problem);
    return json(result, 201);
  } catch (err) {
    return errors(err);
  }
}
