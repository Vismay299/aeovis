// F23 §6.2.8 — the `<report_templates>` system-prompt block. Own code.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { listReportTemplates } from "./templateService.ts";

/**
 * Template names and descriptions are written by workspace members and this block
 * sits in the SYSTEM prompt of every turn in the workspace, owners' included, so
 * a member must not be able to end the block or start a line of their own. Each
 * value becomes one line of plain text: control and format characters and every
 * line break are collapsed to a space, and angle brackets are removed so no tag
 * can open or close. The id is a UUID and needs nothing.
 */
export function oneLine(value: string): string {
  return value
    .replace(/[<>]/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
}

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
  const lines = templates.map((template) => {
    const name = oneLine(template.name) || "Untitled template";
    const description = oneLine(template.description);
    return `- ${name} (id ${template.id})${description ? `: ${description}` : ""}`;
  });
  return (
    "Report templates are the user's briefs for reports. Use one only when the user names it or asks for the kind of report it describes; pass its id to save_report as templateId.\n" +
    "<report_templates>\n" +
    lines.join("\n") +
    "\n</report_templates>"
  );
}
