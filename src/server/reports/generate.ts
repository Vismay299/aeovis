// F23 §6.2.8 — start a report generation from a template. Own code.

import { AppError } from "../../shared/http/appError.ts";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { createSession, renameSession } from "../assistant/sessions.ts";
import { getReportTemplate } from "./templateService.ts";
import { captureReportEvent } from "./telemetry.ts";

export type StartReportGenerationDeps = {
  isFeatureEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  getReportTemplate?: typeof getReportTemplate;
  createSession?: typeof createSession;
  renameSession?: typeof renameSession;
};

const FEATURE_OFF = "This page is not available for your workspace yet.";

/**
 * Requires `reports`, `report_generate` and `assistant`, loads the template,
 * then opens an assistant session with a `generate_report` kickoff and renames
 * it to "Report: {name}". The path is the portal chat that will run the kickoff.
 */
export async function startReportGeneration(
  ws: Workspace,
  input: { templateId: string },
  deps?: StartReportGenerationDeps,
): Promise<{ sessionId: string; path: string }> {
  const flag = deps?.isFeatureEnabled ?? isFeatureEnabledDefault;
  const reportsOn = await flag("reports", ws.brandKey);
  const generateOn = await flag("report_generate", ws.brandKey);
  const assistantOn = await flag("assistant", ws.brandKey);
  if (!reportsOn || !generateOn || !assistantOn) {
    throw new AppError(404, "feature_unavailable", FEATURE_OFF);
  }
  const template = await (deps?.getReportTemplate ?? getReportTemplate)(
    ws.admin,
    ws.brandKey,
    input.templateId,
  );
  const session = await (deps?.createSession ?? createSession)(ws.admin, {
    brandKey: ws.brandKey,
    userId: ws.user.id,
    kickoff: { kind: "generate_report", templateId: template.id },
  });
  await (deps?.renameSession ?? renameSession)(ws.admin, {
    id: session.id,
    brandKey: ws.brandKey,
    userId: ws.user.id,
    title: (`Report: ${template.name}`).slice(0, 80),
  });
  captureReportEvent("report:generate_start", {});
  return { sessionId: session.id, path: `/portal/assistant?s=${session.id}` };
}
