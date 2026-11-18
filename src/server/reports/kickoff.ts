// F23 §6.2.8 — the `generate_report` kickoff. Imported for its side effect
// from F22's `src/server/assistant/kickoffKinds.ts`.

import { AppError } from "../../shared/http/appError.ts";
import { registerKickoff, type KickoffInput } from "../assistant/kickoff.ts";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { getReportTemplate } from "./templateService.ts";

export type GenerateKickoffDeps = {
  isFeatureEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  getReportTemplate?: typeof getReportTemplate;
};

const CLOSING_TAG = new RegExp("</report_template", "gi");

/**
 * The opening message of a generation. The template is the user's brief and goes
 * in a tag the model can tell apart from our own words; a closing tag inside it
 * is defused so the brief cannot end the block early. The `seo-report` skill is
 * named only when skills are on: `activate_skill` does not exist otherwise, and a
 * prompt that tells the model to call a missing tool wastes its first step.
 * `getReportTemplate` answers a deleted template with `template_not_found`, which
 * the kickoff re-raises as a 409 the chat page can show.
 */
export async function buildGenerateReportKickoff(
  { admin, ws, kickoff }: KickoffInput,
  deps: GenerateKickoffDeps = {},
): Promise<{ label: string; text: string }> {
  const templateId = typeof kickoff.templateId === "string" ? kickoff.templateId : "";
  const loadTemplate = async () => {
    try {
      return await (deps.getReportTemplate ?? getReportTemplate)(admin, ws.brandKey, templateId);
    } catch (error) {
      if (error instanceof AppError && error.code === "template_not_found") {
        throw new AppError(409, "template_not_found", "This report template was deleted. Choose another one.");
      }
      throw error;
    }
  };
  // Independent reads, so they run together.
  const [skillsOn, template] = await Promise.all([
    (deps.isFeatureEnabled ?? isFeatureEnabledDefault)("assistant_skills", ws.brandKey),
    loadTemplate(),
  ]);
  const skillStep = skillsOn ? `First call activate_skill with "seo-report". ` : "";
  const instructions = template.instructions.replace(CLOSING_TAG, "&lt;/report_template");
  return {
    label: `Generate a report from \u201C${template.name}\u201D`,
    text:
      `Write a report using the report template \u201C${template.name}\u201D (id ${template.id}). ` +
      skillStep +
      `The template is the user's brief: follow its audience, sections, tone and sign-off.\n` +
      `<report_template>\n${instructions}\n</report_template>\n` +
      `Gather the data the template needs with your tools (paid lookups will ask the user first), then save the report with save_report, passing templateId "${template.id}". ` +
      `If something the template asks for is not available, say so in the report instead of inventing it.`,
  };
}

registerKickoff("generate_report", (input) => buildGenerateReportKickoff(input));
