// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/services/ReportTemplateService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, isAppError } from "../../shared/http/appError.ts";
import {
  REPORT_TEMPLATE_MAX_DESCRIPTION_CHARS,
  REPORT_TEMPLATE_MAX_INSTRUCTIONS_CHARS,
  REPORT_TEMPLATE_MAX_NAME_CHARS,
  REPORT_TEMPLATE_MAX_PER_WORKSPACE,
  type ReportTemplate,
} from "../../shared/reports.ts";
import {
  reportTemplateStore,
  type ReportTemplateStore,
} from "./templateRepository.ts";
import { templateNotFoundError } from "./messages.ts";

// Report templates: the named briefs the assistant follows when writing a
// report. Every caller comes through here, so the caps and the refusal copy
// exist once. Authorization is NOT done here — the caller has already
// authorized `brandKey` and every query is scoped to it.

const counts = new Intl.NumberFormat("en-US");
const formatCount = (value: number) => counts.format(value);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReportTemplateServiceDeps = {
  store?: ReportTemplateStore;
};

export type SaveReportTemplateResult = {
  templateId: string;
  name: string;
  created: boolean;
};

type SaveReportTemplateParams = {
  brandKey: string;
  templateId?: string;
  name: string;
  description: string;
  instructions: string;
  /** Client label, stamped by the server. Never taken from the model. */
  createdBy: "app";
  /** From the authenticated context, and nowhere else. */
  createdByUserId: string;
};

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23505";
}

/** This workspace's templates, and the room left under the cap. */
export async function listReportTemplates(
  admin: SupabaseClient,
  brandKey: string,
  deps?: ReportTemplateServiceDeps
): Promise<{ templates: ReportTemplate[]; remaining: number }> {
  const store = deps?.store ?? reportTemplateStore(admin);
  const templates = await store.listTemplates(brandKey);
  return {
    templates,
    remaining: Math.max(0, REPORT_TEMPLATE_MAX_PER_WORKSPACE - templates.length),
  };
}

export async function getReportTemplate(
  admin: SupabaseClient,
  brandKey: string,
  templateId: string,
  deps?: ReportTemplateServiceDeps
): Promise<ReportTemplate> {
  const store = deps?.store ?? reportTemplateStore(admin);
  const template =
    UUID_PATTERN.test(templateId) ? await store.getTemplate(brandKey, templateId) : null;
  if (!template) throw templateNotFoundError(templateId);
  return template;
}

/**
 * Create-or-update in one call. Everything is validated before anything is
 * written, so a rejected save leaves the stored template untouched.
 *
 * The order is F23 §6.2.3: name, description, instructions, then the id read
 * (which also serves the duplicate-name check), then the create cap.
 */
export async function saveReportTemplate(
  admin: SupabaseClient,
  params: SaveReportTemplateParams,
  deps?: ReportTemplateServiceDeps
): Promise<SaveReportTemplateResult> {
  const store = deps?.store ?? reportTemplateStore(admin);
  const name = params.name.trim();
  const description = params.description.trim();
  const instructions = params.instructions.trim();

  if (name.length === 0) {
    throw new AppError(400, "template_name_required", "Give the template a name.");
  }
  if (name.length > REPORT_TEMPLATE_MAX_NAME_CHARS) {
    throw new AppError(
      400,
      "template_name_too_long",
      `Name is ${formatCount(name.length)} characters; the limit is ${formatCount(REPORT_TEMPLATE_MAX_NAME_CHARS)}. Shorten it and save again.`
    );
  }
  if (description.length === 0) {
    throw new AppError(
      400,
      "template_description_required",
      "Add a one-line description saying when to use this template. It is what the assistant reads to decide."
    );
  }
  if (description.length > REPORT_TEMPLATE_MAX_DESCRIPTION_CHARS) {
    throw new AppError(
      400,
      "template_description_too_long",
      `Description is ${formatCount(description.length)} characters; the limit is ${formatCount(REPORT_TEMPLATE_MAX_DESCRIPTION_CHARS)}. It is one line saying when to use the template — move the detail into the instructions.`
    );
  }
  if (instructions.length === 0) {
    throw new AppError(
      400,
      "template_instructions_required",
      "Add instructions: the audience, the sections in order, the tone, and the sign-off."
    );
  }
  if (instructions.length > REPORT_TEMPLATE_MAX_INSTRUCTIONS_CHARS) {
    throw new AppError(
      400,
      "template_instructions_too_long",
      `Instructions are ${formatCount(instructions.length)} characters; the limit is ${formatCount(REPORT_TEMPLATE_MAX_INSTRUCTIONS_CHARS)}. A template is a brief, not the report — say the audience, the sections in order, the tone and the sign-off, and cut the rest.`
    );
  }

  // One read serves the existence check, the duplicate-name check and the cap.
  // UUIDs are case-insensitive in Postgres and in this service's own
  // `UUID_PATTERN` (/i), so normalise the caller's spelling before comparing it
  // with the stored ids; otherwise an upper-cased real id is a false 404.
  const templateId = params.templateId?.toLowerCase();
  const templates = await store.listTemplates(params.brandKey);
  const existing = templateId
    ? templates.find((template) => template.id === templateId)
    : undefined;
  if (templateId && !existing) throw templateNotFoundError(templateId);

  // A name that appears twice in a workspace makes "use the monthly check-in
  // template" ambiguous, so a rename clears the same bar as a create. The
  // compare is case-insensitive; the unique index is on `lower(name)`.
  const lowerName = name.toLowerCase();
  const clash = templates.find(
    (template) => template.name.toLowerCase() === lowerName && template.id !== existing?.id
  );
  if (clash) {
    throw new AppError(
      409,
      "template_name_taken",
      `A template named "${name}" exists in this workspace. Choose another name.`
    );
  }

  if (existing) {
    try {
      await store.updateTemplate({
        templateId: existing.id,
        brandKey: params.brandKey,
        name,
        description,
        instructions,
      });
    } catch (error) {
      throw mapWriteError(error, name);
    }
    return { templateId: existing.id, name, created: false };
  }

  // Plain read-then-write: concurrent saves can both pass at the cap, which is
  // accepted — this is a guardrail, not an invariant, and the next save refuses.
  if (templates.length >= REPORT_TEMPLATE_MAX_PER_WORKSPACE) {
    throw new AppError(
      409,
      "template_limit",
      `This workspace has ${formatCount(REPORT_TEMPLATE_MAX_PER_WORKSPACE)} report templates, the limit. Delete one from the Templates page.`
    );
  }

  const newTemplateId = randomUUID();
  try {
    await store.insertTemplate({
      id: newTemplateId,
      brandKey: params.brandKey,
      name,
      description,
      instructions,
      createdBy: params.createdBy,
      createdByUserId: params.createdByUserId,
    });
  } catch (error) {
    throw mapWriteError(error, name);
  }
  return { templateId: newTemplateId, name, created: true };
}

function mapWriteError(error: unknown, name: string): AppError {
  if (isUniqueViolation(error)) {
    return new AppError(
      409,
      "template_name_taken",
      `A template named "${name}" exists in this workspace. Choose another name.`
    );
  }
  if (isAppError(error)) return error;
  return new AppError(503, "reports_unavailable", "Report templates are unavailable. Please retry.");
}

export async function deleteReportTemplate(
  admin: SupabaseClient,
  brandKey: string,
  templateId: string,
  deps?: ReportTemplateServiceDeps
): Promise<void> {
  const store = deps?.store ?? reportTemplateStore(admin);
  const deleted = UUID_PATTERN.test(templateId)
    ? await store.deleteTemplate(brandKey, templateId)
    : false;
  // Reports keep their `template_id` (there is no FK): deleting a template never
  // touches a report, and the report's Type falls back to the skill.
  if (!deleted) throw templateNotFoundError(templateId);
}
