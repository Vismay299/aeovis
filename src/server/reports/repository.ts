// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/repositories/ReportRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportCreatedBy, ReportMetadata } from "../../shared/reports.ts";
import { reportNotFoundError } from "./messages.ts";

// Backing store for reports. Every query filters on `brand_key` as well as `id`:
// callers authorize the workspace they were given, not the child row, so a
// guessed id from another workspace must not resolve.
//
// `html` is never selected here except by getReportHtml/getReportWithHtml — a
// list read that pulled documents would put megabytes on a worker's heap.
//
// The service depends on the ReportStore interface, not on Supabase: tests use
// the in-memory implementation in memoryStore.ts, and production uses the
// service-role client handed in by the caller.

export type ReportRowWithHtml = ReportMetadata & { html: string };

export type NewReportRow = {
  id: string;
  brandKey: string;
  title: string;
  summary: string;
  html: string;
  skill: string | null;
  skillVersion: string | null;
  templateId: string | null;
  sessionId: string | null;
  createdBy: ReportCreatedBy;
  createdByUserId: string;
  sizeBytes: number;
  sanitizerVersion: number;
};

export type ReportContentUpdate = {
  reportId: string;
  brandKey: string;
  title: string;
  summary: string;
  html: string;
  skill: string | null;
  skillVersion: string | null;
  templateId: string | null;
  sizeBytes: number;
  sanitizerVersion: number;
};

export type ShareMint = {
  shareToken: string | null;
  sharedAt: string | null;
  created: boolean;
};

export type ReportStore = {
  listReports(input: { brandKey: string; limit: number; offset: number }): Promise<ReportMetadata[]>;
  getReport(brandKey: string, reportId: string): Promise<ReportMetadata | null>;
  getReportHtml(brandKey: string, reportId: string): Promise<string | null>;
  getReportWithHtml(brandKey: string, reportId: string): Promise<ReportRowWithHtml | null>;
  findReportByTitle(brandKey: string, title: string): Promise<{ id: string; title: string } | null>;
  countReports(brandKey: string): Promise<number>;
  workspaceUsage(brandKey: string): Promise<{ reportCount: number; totalBytes: number }>;
  insertReport(row: NewReportRow): Promise<void>;
  updateReportContent(row: ReportContentUpdate): Promise<void>;
  mintShareToken(input: {
    brandKey: string;
    reportId: string;
    token: string;
    userId: string;
  }): Promise<ShareMint>;
  clearShareToken(input: { brandKey: string; reportId: string }): Promise<boolean>;
  sumBrowserViews(input: {
    brandKey: string;
    reportId: string;
    pseudonym: string;
    sinceDay: string;
  }): Promise<number>;
  deleteReport(brandKey: string, reportId: string): Promise<boolean>;
};

const METADATA_COLUMNS =
  "id,brand_key,title,summary,skill,skill_version,template_id,session_id,created_by,created_by_user_id,size_bytes,sanitizer_version,share_token,shared_at,created_at,updated_at";

type ReportRow = {
  id: string;
  brand_key: string;
  title: string;
  summary: string;
  skill: string | null;
  skill_version: string | null;
  template_id: string | null;
  session_id: string | null;
  created_by: ReportCreatedBy;
  created_by_user_id: string | null;
  size_bytes: number;
  sanitizer_version: number;
  share_token: string | null;
  shared_at: string | null;
  created_at: string;
  updated_at: string;
};

function toMetadata(row: ReportRow): ReportMetadata {
  return {
    id: row.id,
    brandKey: row.brand_key,
    title: row.title,
    summary: row.summary,
    skill: row.skill,
    skillVersion: row.skill_version,
    templateId: row.template_id,
    sessionId: row.session_id,
    createdBy: row.created_by,
    createdByUserId: row.created_by_user_id,
    sizeBytes: row.size_bytes,
    sanitizerVersion: row.sanitizer_version,
    shareToken: row.share_token,
    sharedAt: row.shared_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The write path's errors stay raw so the service can spot a unique violation. */
function raiseWriteError(error: unknown): never {
  throw error;
}

/** The production store, bound to one service-role client. */
export function reportStore(admin: SupabaseClient): ReportStore {
  return {
    async listReports({ brandKey, limit, offset }) {
      const { data, error } = await admin
        .from("reports")
        .select(METADATA_COLUMNS)
        .eq("brand_key", brandKey)
        // Matches reports_list_idx. `id` breaks same-timestamp ties so the
        // order is total.
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return ((data ?? []) as unknown as ReportRow[]).map(toMetadata);
    },

    async getReport(brandKey, reportId) {
      const { data, error } = await admin
        .from("reports")
        .select(METADATA_COLUMNS)
        .eq("id", reportId)
        .eq("brand_key", brandKey)
        .maybeSingle();
      if (error) throw error;
      return data ? toMetadata(data as unknown as ReportRow) : null;
    },

    async getReportHtml(brandKey, reportId) {
      const { data, error } = await admin
        .from("reports")
        .select("html")
        .eq("id", reportId)
        .eq("brand_key", brandKey)
        .maybeSingle();
      if (error) throw error;
      return (data as { html?: string } | null)?.html ?? null;
    },

    async getReportWithHtml(brandKey, reportId) {
      const { data, error } = await admin
        .from("reports")
        .select(`${METADATA_COLUMNS},html`)
        .eq("id", reportId)
        .eq("brand_key", brandKey)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const row = data as unknown as ReportRow & { html: string };
      return { ...toMetadata(row), html: row.html };
    },

    async findReportByTitle(brandKey, title) {
      const { data, error } = await admin
        .from("reports")
        .select("id,title")
        .eq("brand_key", brandKey)
        .eq("title", title)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as { id: string; title: string } | null) ?? null;
    },

    async countReports(brandKey) {
      const { count, error } = await admin
        .from("reports")
        .select("id", { count: "exact", head: true })
        .eq("brand_key", brandKey);
      if (error) throw error;
      return count ?? 0;
    },

    async workspaceUsage(brandKey) {
      const { data, error } = await admin.rpc("report_workspace_usage", { p_brand: brandKey });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as
        | { report_count?: number | string; total_bytes?: number | string }
        | null
        | undefined;
      return {
        reportCount: Number(row?.report_count ?? 0),
        totalBytes: Number(row?.total_bytes ?? 0),
      };
    },

    async insertReport(row) {
      const { error } = await admin.from("reports").insert({
        id: row.id,
        brand_key: row.brandKey,
        title: row.title,
        summary: row.summary,
        html: row.html,
        skill: row.skill,
        skill_version: row.skillVersion,
        template_id: row.templateId,
        session_id: row.sessionId,
        created_by: row.createdBy,
        created_by_user_id: row.createdByUserId,
        size_bytes: row.sizeBytes,
        sanitizer_version: row.sanitizerVersion,
      });
      if (error) raiseWriteError(error);
    },

    async updateReportContent(row) {
      // Content only: `created_by`, `created_by_user_id`, `created_at`, the
      // share columns and the session are never re-stamped here. `updated_at`
      // is set by the reports_touch trigger, which bumps it only when content
      // actually changed.
      const { error } = await admin
        .from("reports")
        .update({
          title: row.title,
          summary: row.summary,
          html: row.html,
          skill: row.skill,
          skill_version: row.skillVersion,
          template_id: row.templateId,
          size_bytes: row.sizeBytes,
          sanitizer_version: row.sanitizerVersion,
        })
        .eq("id", row.reportId)
        .eq("brand_key", row.brandKey);
      if (error) raiseWriteError(error);
    },

    async mintShareToken({ brandKey, reportId, token, userId }) {
      // Race-safe: the SQL function keeps the first token, and a second caller
      // reads the winner back. A vanished row raises `report_not_found`.
      const { data, error } = await admin.rpc("set_report_share_token", {
        p_report: reportId,
        p_brand: brandKey,
        p_token: token,
        p_user: userId,
      });
      if (error) {
        if (String(error.message ?? "").includes("report_not_found")) throw reportNotFoundError(reportId);
        throw error;
      }
      const row = (Array.isArray(data) ? data[0] : data) as
        | { share_token?: string | null; shared_at?: string | null; created?: boolean }
        | null
        | undefined;
      return {
        shareToken: row?.share_token ?? null,
        sharedAt: row?.shared_at ?? null,
        created: row?.created === true,
      };
    },

    async clearShareToken({ brandKey, reportId }) {
      const { data, error } = await admin.rpc("clear_report_share_token", {
        p_report: reportId,
        p_brand: brandKey,
      });
      if (error) {
        if (String(error.message ?? "").includes("report_not_found")) throw reportNotFoundError(reportId);
        throw error;
      }
      return data === true;
    },

    async sumBrowserViews({ brandKey, reportId, pseudonym, sinceDay }) {
      const { data, error } = await admin
        .from("report_share_views")
        .select("browser_views")
        .eq("brand_key", brandKey)
        .eq("report_id", reportId)
        .eq("share_pseudonym", pseudonym)
        .gte("day", sinceDay);
      if (error) throw error;
      let total = 0;
      for (const row of (data ?? []) as unknown as Array<{ browser_views: number | string }>) {
        total += Number(row.browser_views) || 0;
      }
      return total;
    },

    async deleteReport(brandKey, reportId) {
      const { data, error } = await admin
        .from("reports")
        .delete()
        .eq("id", reportId)
        .eq("brand_key", brandKey)
        .select("id");
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },
  };
}
