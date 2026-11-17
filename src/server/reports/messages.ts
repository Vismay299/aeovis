import { AppError } from "../../shared/http/appError.ts";
import type { ReportMetadata } from "../../shared/reports.ts";

// F23 refusal copy that more than one module needs. Keeping it here rather than
// in the service lets the repository answer a vanished row (the SQL mint raises
// `report_not_found` when the row is gone) with the same sentence a direct read
// uses, without a service → repository → service import cycle.

/**
 * A report that does not resolve inside the caller's workspace. The `save` arm
 * carries the extra hint `save_report` gives ("omit reportId to create a new
 * one"); the read/delete arm names `list_reports` alone.
 */
export function reportNotFoundError(
  reportId: string,
  options: { save?: boolean } = {}
): AppError {
  const hint = options.save
    ? "Call list_reports, or omit reportId to create a new one."
    : "Call list_reports to see what exists.";
  return new AppError(404, "report_not_found", `No report ${reportId} in this workspace. ${hint}`);
}

/** A template that does not resolve inside the caller's workspace. */
export function templateNotFoundError(templateId: string): AppError {
  return new AppError(
    404,
    "template_not_found",
    `No report template ${templateId} in this workspace. Call list_report_templates to see what exists.`
  );
}
