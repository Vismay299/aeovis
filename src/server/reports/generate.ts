// F23 §6.2.8 — start a report generation from a template. Own code.

import { AppError } from "../../shared/http/appError.ts";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { createSession } from "../assistant/sessions.ts";
import { getReportTemplate } from "./templateService.ts";
import { captureReportEvent } from "./telemetry.ts";

export type StartReportGenerationDeps = {
  isFeatureEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  getReportTemplate?: typeof getReportTemplate;
  createSession?: typeof createSession;
};

const FEATURE_OFF = "This page is not available for your workspace yet.";

/**
 * Requires `reports`, `report_generate` and `assistant`, loads the template,
 * then opens an assistant session already titled "Report: {name}" and carrying a
 * `generate_report` kickoff. The path is the portal chat that will run the
 * kickoff. The session is created with its title in one write: a separate rename
 * could fail after the session existed, leaving a stray chat behind for every
 * retry.
 */
export async function startReportGeneration(
  ws: Workspace,
  input: { templateId: string },
  deps?: StartReportGenerationDeps,
): Promise<{ sessionId: string; path: string }> {
  const flag = deps?.isFeatureEnabled ?? isFeatureEnabledDefault;
  const [reportsOn, generateOn, assistantOn] = await Promise.all([
    flag("reports", ws.brandKey),
    flag("report_generate", ws.brandKey),
    flag("assistant", ws.brandKey),
  ]);
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
    title: Array.from(`Report: ${template.name}`).slice(0, 80).join(""),
  });
  captureReportEvent("report:generate_start", {});
  return { sessionId: session.id, path: `/portal/assistant?s=${session.id}` };
}
