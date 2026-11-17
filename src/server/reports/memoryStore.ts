import type { ReportMetadata, ReportTemplate } from "../../shared/reports.ts";
import { reportNotFoundError } from "./messages.ts";
import type { NewReportRow, ReportContentUpdate, ReportStore } from "./repository.ts";
import type { NewReportTemplateRow, ReportTemplateStore } from "./templateRepository.ts";

// In-memory implementations of the two stores, for service tests and route
// fixtures. They mirror the SQL contract of migrations 150 and 151 closely
// enough that a service test proves the real behaviour:
//
//   - title unique per workspace (23505), template name unique per workspace
//     ignoring case (23505);
//   - the check constraints (title/summary lengths, UTF-8 size equals
//     `size_bytes`, sanitizer_version >= 1, token shape, share token and
//     shared_at both null or both set) raise 23514;
//   - the `reports_touch` trigger bumps `updated_at` only when content changed,
//     and restores the attribution columns on every update;
//   - `set_report_share_token` keeps the first token, `clear_report_share_token`
//     nulls the pair, and both raise `report_not_found` for a foreign id;
//   - deleting a template leaves reports (there is no FK), deleting a report
//     deletes its view rows (ON DELETE CASCADE).

type StoredReport = ReportMetadata & { html: string; sessionId: string | null };

type StoredView = {
  report_id: string;
  brand_key: string;
  day: string;
  share_pseudonym: string;
  browser_views: number;
  other_views: number;
};

export type MemoryReportStore = ReportStore & {
  reports: Map<string, StoredReport>;
  views: Map<string, StoredView>;
  recordView(input: {
    reportId: string;
    brandKey: string;
    day: string;
    pseudonym: string;
    fromBrowser: boolean;
  }): void;
  allReports(): StoredReport[];
};

export type MemoryReportTemplateStore = ReportTemplateStore & {
  templates: Map<string, ReportTemplate>;
  allTemplates(): ReportTemplate[];
};

const uniqueViolation = (message: string) => Object.assign(new Error(message), { code: "23505" });
const checkViolation = (message: string) => Object.assign(new Error(message), { code: "23514" });

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const SKILL_PATTERN = /^[a-z][a-z0-9-]{2,59}$/;
const SKILL_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function validateReport(row: NewReportRow | ReportContentUpdate): void {
  if (row.title.length < 1 || row.title.length > 120) throw checkViolation("reports_title_check");
  if (row.summary.length < 1 || row.summary.length > 2_500) throw checkViolation("reports_summary_check");
  const bytes = utf8Bytes(row.html);
  if (bytes < 1 || bytes > 500_000) throw checkViolation("reports_size_bytes_check");
  if (bytes !== row.sizeBytes) throw checkViolation("reports_html_size_check");
  if (row.sanitizerVersion < 1) throw checkViolation("reports_sanitizer_version_check");
  if (row.skill !== null && !SKILL_PATTERN.test(row.skill)) throw checkViolation("reports_skill_check");
  if (row.skillVersion !== null && !SKILL_VERSION_PATTERN.test(row.skillVersion)) {
    throw checkViolation("reports_skill_version_check");
  }
}

export function createMemoryReportStore(opts: { now?: () => Date } = {}): MemoryReportStore {
  const now = opts.now ?? (() => new Date());
  const reports = new Map<string, StoredReport>();
  const views = new Map<string, StoredView>();

  const iso = () => now().toISOString();
  const allDocuments = () => [...reports.values()];

  const copy = (report: StoredReport): ReportMetadata => {
    const { html: _html, sessionId: _sessionId, ...metadata } = report;
    return { ...metadata };
  };

  return {
    reports,
    views,

    allReports() {
      return [...reports.values()].map((r) => ({ ...r }));
    },

    async listReports({ brandKey, limit, offset }) {
      return allDocuments()
        .filter((report) => report.brandKey === brandKey)
        .sort((a, b) => {
          const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
          return byUpdated !== 0 ? byUpdated : b.id.localeCompare(a.id);
        })
        .slice(offset, offset + limit)
        .map(copy);
    },

    async getReport(brandKey, reportId) {
      const report = reports.get(reportId);
      return report && report.brandKey === brandKey ? copy(report) : null;
    },

    async getReportHtml(brandKey, reportId) {
      const report = reports.get(reportId);
      return report && report.brandKey === brandKey ? report.html : null;
    },

    async getReportWithHtml(brandKey, reportId) {
      const report = reports.get(reportId);
      if (!report || report.brandKey !== brandKey) return null;
      return { ...copy(report), html: report.html };
    },

    async findReportByTitle(brandKey, title) {
      const report = allDocuments().find((candidate) => candidate.brandKey === brandKey && candidate.title === title);
      return report ? { id: report.id, title: report.title } : null;
    },

    async countReports(brandKey) {
      return allDocuments().filter((report) => report.brandKey === brandKey).length;
    },

    async workspaceUsage(brandKey) {
      const mine = allDocuments().filter((report) => report.brandKey === brandKey);
      return {
        reportCount: mine.length,
        totalBytes: mine.reduce((total, report) => total + report.sizeBytes, 0),
      };
    },

    async insertReport(row) {
      validateReport(row);
      const clash = allDocuments().find((report) => report.brandKey === row.brandKey && report.title === row.title);
      if (clash) throw uniqueViolation("reports_title_idx");
      const timestamp = iso();
      reports.set(row.id, {
        id: row.id,
        brandKey: row.brandKey,
        title: row.title,
        summary: row.summary,
        skill: row.skill,
        skillVersion: row.skillVersion,
        templateId: row.templateId,
        createdBy: row.createdBy,
        createdByUserId: row.createdByUserId,
        sizeBytes: row.sizeBytes,
        sanitizerVersion: row.sanitizerVersion,
        shareToken: null,
        sharedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        html: row.html,
        sessionId: row.sessionId,
      });
    },

    async updateReportContent(row) {
      validateReport(row);
      const report = reports.get(row.reportId);
      if (!report || report.brandKey !== row.brandKey) return;
      const clash = allDocuments().find(
        (candidate) =>
          candidate.brandKey === row.brandKey &&
          candidate.title === row.title &&
          candidate.id !== row.reportId
      );
      if (clash) throw uniqueViolation("reports_title_idx");

      const contentChanged =
        report.html !== row.html ||
        report.title !== row.title ||
        report.summary !== row.summary ||
        report.skill !== row.skill ||
        report.templateId !== row.templateId;
      // The trigger: content bump only, attribution restored on every update.
      report.title = row.title;
      report.summary = row.summary;
      report.html = row.html;
      report.skill = row.skill;
      report.skillVersion = row.skillVersion;
      report.templateId = row.templateId;
      report.sizeBytes = row.sizeBytes;
      report.sanitizerVersion = row.sanitizerVersion;
      if (contentChanged) report.updatedAt = iso();
    },

    async mintShareToken({ brandKey, reportId, token, userId }) {
      if (!SHARE_TOKEN_PATTERN.test(token)) throw checkViolation("reports_share_token_check");
      const report = reports.get(reportId);
      if (!report || report.brandKey !== brandKey) throw reportNotFoundError(reportId);
      if (report.shareToken) {
        return { shareToken: report.shareToken, sharedAt: report.sharedAt, created: false };
      }
      const clash = allDocuments().find((candidate) => candidate.shareToken === token);
      if (clash) throw uniqueViolation("reports_share_token_idx");
      report.shareToken = token;
      report.sharedAt = iso();
      void userId;
      // Sharing is not a content change: updated_at stays where it was.
      return { shareToken: report.shareToken, sharedAt: report.sharedAt, created: true };
    },

    async clearShareToken({ brandKey, reportId }) {
      const report = reports.get(reportId);
      if (!report || report.brandKey !== brandKey) throw reportNotFoundError(reportId);
      if (!report.shareToken) return false;
      report.shareToken = null;
      report.sharedAt = null;
      return true;
    },

    async sumBrowserViews({ brandKey, reportId, pseudonym, sinceDay }) {
      let total = 0;
      for (const view of views.values()) {
        if (
          view.brand_key === brandKey &&
          view.report_id === reportId &&
          view.share_pseudonym === pseudonym &&
          view.day >= sinceDay
        ) {
          total += view.browser_views;
        }
      }
      return total;
    },

    async deleteReport(brandKey, reportId) {
      const report = reports.get(reportId);
      if (!report || report.brandKey !== brandKey) return false;
      reports.delete(reportId);
      for (const [key, view] of views) if (view.report_id === reportId) views.delete(key);
      return true;
    },

    recordView({ reportId, brandKey, day, pseudonym, fromBrowser }) {
      const key = `${reportId}|${day}|${pseudonym}`;
      const existing = views.get(key) ?? {
        report_id: reportId,
        brand_key: brandKey,
        day,
        share_pseudonym: pseudonym,
        browser_views: 0,
        other_views: 0,
      };
      if (fromBrowser) existing.browser_views += 1;
      else existing.other_views += 1;
      views.set(key, existing);
    },
  };
}

export function createMemoryReportTemplateStore(
  opts: { now?: () => Date } = {}
): MemoryReportTemplateStore {
  const now = opts.now ?? (() => new Date());
  const templates = new Map<string, ReportTemplate>();
  const iso = () => now().toISOString();

  const validate = (row: { name: string; description: string; instructions: string }) => {
    if (row.name.length < 1 || row.name.length > 80) throw checkViolation("report_templates_name_check");
    if (row.description.length < 1 || row.description.length > 200) {
      throw checkViolation("report_templates_description_check");
    }
    if (row.instructions.length < 1 || row.instructions.length > 3_000) {
      throw checkViolation("report_templates_instructions_check");
    }
  };

  const clash = (brandKey: string, name: string, exceptId?: string) =>
    [...templates.values()].find(
      (template) =>
        template.brandKey === brandKey &&
        template.name.toLowerCase() === name.toLowerCase() &&
        template.id !== exceptId
    );

  return {
    templates,

    allTemplates() {
      return [...templates.values()].map((template) => ({ ...template }));
    },

    async listTemplates(brandKey) {
      return [...templates.values()]
        .filter((template) => template.brandKey === brandKey)
        .sort((a, b) => {
          const byName = a.name.localeCompare(b.name);
          return byName !== 0 ? byName : a.id.localeCompare(b.id);
        })
        .map((template) => ({ ...template }));
    },

    async getTemplate(brandKey, templateId) {
      const template = templates.get(templateId);
      return template && template.brandKey === brandKey ? { ...template } : null;
    },

    async insertTemplate(row) {
      validate(row);
      if (clash(row.brandKey, row.name)) throw uniqueViolation("report_templates_name_idx");
      const timestamp = iso();
      templates.set(row.id, {
        id: row.id,
        brandKey: row.brandKey,
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        createdBy: row.createdBy,
        createdByUserId: row.createdByUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    async updateTemplate(row) {
      validate(row);
      const template = templates.get(row.templateId);
      if (!template || template.brandKey !== row.brandKey) return;
      if (clash(row.brandKey, row.name, row.templateId)) throw uniqueViolation("report_templates_name_idx");
      template.name = row.name;
      template.description = row.description;
      template.instructions = row.instructions;
      // The template trigger bumps on every update, not only content changes.
      template.updatedAt = iso();
    },

    async deleteTemplate(brandKey, templateId) {
      const template = templates.get(templateId);
      if (!template || template.brandKey !== brandKey) return false;
      templates.delete(templateId);
      return true;
    },
  };
}

/** One clock for both stores, so a test's timestamps line up. */
export function createMemoryStores(opts: { now?: () => Date } = {}): {
  reports: MemoryReportStore;
  templates: MemoryReportTemplateStore;
} {
  const now = opts.now ?? (() => new Date());
  return {
    reports: createMemoryReportStore({ now }),
    templates: createMemoryReportTemplateStore({ now }),
  };
}
