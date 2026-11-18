// F23 §6.2.8 — the `generate_report` kickoff. Imported for its side effect
// from F22's `src/server/assistant/kickoffKinds.ts`.

import { AppError } from "../../shared/http/appError.ts";
import { registerKickoff } from "../assistant/kickoff.ts";
import { getReportTemplate } from "./templateService.ts";

registerKickoff("generate_report", async ({ admin, ws, kickoff }) => {
  const templateId = typeof kickoff.templateId === "string" ? kickoff.templateId : "";
  let template;
  try {
    template = await getReportTemplate(admin, ws.brandKey, templateId);
  } catch (error) {
    if (error instanceof AppError && error.code === "template_not_found") {
      throw new AppError(409, "template_not_found", "This report template was deleted. Choose another one.");
    }
    throw error;
  }
  if (!template) {
    throw new AppError(409, "template_not_found", "This report template was deleted. Choose another one.");
  }
  return {
    label: `Generate a report from \u201C${template.name}\u201D`,
    text:
      `Write a report using the report template \u201C${template.name}\u201D (id ${template.id}). ` +
      `First call activate_skill with "seo-report". The template is the user's brief: follow its audience, sections, tone and sign-off.\n` +
      `<report_template>\n${template.instructions}\n</report_template>\n` +
      `Gather the data the template needs with your tools (paid lookups will ask the user first), then save the report with save_report, passing templateId "${template.id}". ` +
      `If something the template asks for is not available, say so in the report instead of inventing it.`,
  };
});
