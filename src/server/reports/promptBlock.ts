// F23 §6.2.8 — the `<report_templates>` system-prompt block. Own code.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { listReportTemplates } from "./templateService.ts";

export type PromptBlockDeps = {
  isFeatureEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  listReportTemplates?: typeof listReportTemplates;
};

/**
 * Null when `reports` is off or there are no templates; otherwise the brief
 * list the assistant reads to decide whether a template applies.
 */
export async function buildTemplatesBlock(
  admin: SupabaseClient,
  brandKey: string,
  deps?: PromptBlockDeps,
): Promise<string | null> {
  const flag = deps?.isFeatureEnabled ?? isFeatureEnabledDefault;
  if (!(await flag("reports", brandKey))) return null;
  const { templates } = await (deps?.listReportTemplates ?? listReportTemplates)(admin, brandKey);
  if (templates.length === 0) return null;
  const lines = templates.map(
    (template) => `- ${template.name} (id ${template.id}): ${template.description}`,
  );
  return (
    "Report templates are the user's briefs for reports. Use one only when the user names it or asks for the kind of report it describes; pass its id to save_report as templateId.\n" +
    "<report_templates>\n" +
    lines.join("\n") +
    "\n</report_templates>"
  );
}
