import { readJsonBody, toErrorResponse } from "../../../../../../../shared/http/errors.ts";
import {
  approvalParam,
  json,
  requireAssistantWorkspace,
  type AssistantRouteDeps,
} from "../../../../../../../server/assistant/routeDeps.ts";
import {
  assistantBrandQuery,
  assistantDecideRequestSchema,
} from "../../../../../../../server/assistant/assistant.contract.ts";
import { decideApproval } from "../../../../../../../server/assistant/approvals.ts";
import type { ApprovalDeps } from "../../../../../../../server/assistant/approvals.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

type Context = { params: Promise<{ approvalId: string }> | { approvalId: string } };

export type AssistantDecideRouteDeps = AssistantRouteDeps & {
  decideApproval?: typeof decideApproval;
  approvalDeps?: ApprovalDeps;
};

export async function POST(request: Request, context: Context, deps?: AssistantDecideRouteDeps): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const parsed = assistantDecideRequestSchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireAssistantWorkspace(request, parsed.data.brand_key, deps);
    const approvalId = await approvalParam(context);
    const approval = await (deps?.decideApproval ?? decideApproval)(
      {
        ws: workspace,
        approvalId,
        decision: parsed.data.decision,
        maxUsd: parsed.data.maxUsd,
      },
      {
        ...deps?.approvalDeps,
        ...(deps?.isFeatureEnabled ? { isFeatureEnabled: deps.isFeatureEnabled } : {}),
      },
    );
    return json({ approval });
  } catch (err) {
    return toErrorResponse(err);
  }
}
