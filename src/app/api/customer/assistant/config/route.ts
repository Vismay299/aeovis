import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import "../../../../../shared/pricing/actions/index.ts";
import { assistantBrandQuery, assistantConfigResponseSchema } from "../../../../../server/assistant/assistant.contract.ts";
import { assistantConfigured, readAssistantConfig } from "../../../../../server/assistant/config.ts";
import {
  brandKeyFrom,
  json,
  queryObject,
  requireAssistantWorkspace,
  type AssistantRouteDeps,
} from "../../../../../server/assistant/routeDeps.ts";
import { availableTools } from "../../../../../server/tools/registry.ts";
import { listSkills } from "../../../../../assistant/skills/index.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";

export const dynamic = "force-dynamic";

export const ASSISTANT_SUGGESTIONS = [
  "Where do AI answers name competitors but not us?",
  "Which questions should we add to our panel?",
  "Can AI crawlers read our website?",
  "What should we write next to get cited?",
];

export type AssistantConfigRouteDeps = AssistantRouteDeps & {
  availableTools?: typeof availableTools;
  assistantConfigured?: typeof assistantConfigured;
  readAssistantConfig?: typeof readAssistantConfig;
  listSkills?: typeof listSkills;
};

export async function GET(request: Request, _ctx?: unknown, deps?: AssistantConfigRouteDeps): Promise<Response> {
  try {
    const query = assistantBrandQuery.safeParse(queryObject(request));
    if (!query.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
    const workspace = await requireAssistantWorkspace(request, brandKeyFrom(request, assistantBrandQuery), deps);
    const cfg = (deps?.readAssistantConfig ?? readAssistantConfig)(process.env);
    const configured = (deps?.assistantConfigured ?? assistantConfigured)(process.env);
    const regs = await (deps?.availableTools ?? availableTools)({
      brandKey: workspace.brandKey,
      role: workspace.role,
    });
    const flag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    const skills = (deps?.listSkills ?? listSkills)({
      availableTools: new Set(regs.map((reg) => reg.def.name)),
      enabled: await flag("assistant_skills", workspace.brandKey),
    });
    return json(
      assistantConfigResponseSchema.parse({
        ...(configured.ok ? { configured: true } : { configured: false, reason: configured.code }),
        turnMaxUsd: cfg.turnMaxUsd,
        approvalTtlSeconds: cfg.approvalTtlSeconds,
        skills,
        suggestions: ASSISTANT_SUGGESTIONS,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
