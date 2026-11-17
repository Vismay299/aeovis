// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/repositories/ReportTemplateRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportCreatedBy, ReportTemplate } from "../../shared/reports.ts";

// Backing store for report templates. Every query filters on `brand_key` as well
// as `id` — never a bare `WHERE id = ?` — because callers authorize the
// workspace they were given, not the child row.

export type NewReportTemplateRow = {
  id: string;
  brandKey: string;
  name: string;
  description: string;
  instructions: string;
  createdBy: ReportCreatedBy;
  createdByUserId: string;
};

export type ReportTemplateUpdate = {
  templateId: string;
  brandKey: string;
  name: string;
  description: string;
  instructions: string;
};

export type ReportTemplateStore = {
  listTemplates(brandKey: string): Promise<ReportTemplate[]>;
  getTemplate(brandKey: string, templateId: string): Promise<ReportTemplate | null>;
  insertTemplate(row: NewReportTemplateRow): Promise<void>;
  updateTemplate(row: ReportTemplateUpdate): Promise<void>;
  deleteTemplate(brandKey: string, templateId: string): Promise<boolean>;
};

const COLUMNS =
  "id,brand_key,name,description,instructions,created_by,created_by_user_id,created_at,updated_at";

type TemplateRow = {
  id: string;
  brand_key: string;
  name: string;
  description: string;
  instructions: string;
  created_by: ReportCreatedBy;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

function toTemplate(row: TemplateRow): ReportTemplate {
  return {
    id: row.id,
    brandKey: row.brand_key,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    createdBy: row.created_by,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The production store, bound to one service-role client. */
export function reportTemplateStore(admin: SupabaseClient): ReportTemplateStore {
  return {
    async listTemplates(brandKey) {
      const { data, error } = await admin
        .from("report_templates")
        .select(COLUMNS)
        .eq("brand_key", brandKey)
        .order("name", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as unknown as TemplateRow[]).map(toTemplate);
    },

    async getTemplate(brandKey, templateId) {
      const { data, error } = await admin
        .from("report_templates")
        .select(COLUMNS)
        .eq("id", templateId)
        .eq("brand_key", brandKey)
        .maybeSingle();
      if (error) throw error;
      return data ? toTemplate(data as unknown as TemplateRow) : null;
    },

    async insertTemplate(row) {
      const { error } = await admin.from("report_templates").insert({
        id: row.id,
        brand_key: row.brandKey,
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        created_by: row.createdBy,
        created_by_user_id: row.createdByUserId,
      });
      // Raw: the service turns a unique violation into `template_name_taken`.
      if (error) throw error;
    },

    async updateTemplate(row) {
      // Content only: the attribution columns are stamped at create and never
      // re-stamped, so "created by" keeps meaning what it says after an edit.
      const { error } = await admin
        .from("report_templates")
        .update({
          name: row.name,
          description: row.description,
          instructions: row.instructions,
        })
        .eq("id", row.templateId)
        .eq("brand_key", row.brandKey);
      if (error) throw error;
    },

    async deleteTemplate(brandKey, templateId) {
      const { data, error } = await admin
        .from("report_templates")
        .delete()
        .eq("id", templateId)
        .eq("brand_key", brandKey)
        .select("id");
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },
  };
}
