import { toErrorResponse } from "../../../../../../shared/http/errors.ts";
import {
  approvalParam,
  brandKeyFrom,
  json,
  requireAssistantWorkspace,
  type AssistantRouteDeps,
} from "../../../../../../server/assistant/routeDeps.ts";
import { assistantBrandQuery } from "../../../../../../server/assistant/assistant.contract.ts";
import { getApprovalView } from "../../../../../../server/assistant/approvals.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ approvalId: string }> | { approvalId: string } };

export type AssistantApprovalRouteDeps = AssistantRouteDeps & {
  getApprovalView?: typeof getApprovalView;
};

export async function GET(request: Request, context: Context, deps?: AssistantApprovalRouteDeps): Promise<Response> {
  try {
    const workspace = await requireAssistantWorkspace(request, brandKeyFrom(request, assistantBrandQuery), deps);
    const approvalId = await approvalParam(context);
    const approval = await (deps?.getApprovalView ?? getApprovalView)(workspace.admin, {
      approvalId,
      brandKey: workspace.brandKey,
      userId: workspace.user.id,
    });
    return json({ approval });
  } catch (err) {
    return toErrorResponse(err);
  }
}
