// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/services/ReportService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, isAppError } from "../../shared/http/appError.ts";
import { mintShareToken, sharePseudonym } from "../../shared/report-share.ts";
import {
  REPORT_MAX_BYTES_PER_WORKSPACE,
  REPORT_MAX_HTML_BYTES,
  REPORT_MAX_INPUT_BYTES,
  REPORT_MAX_PER_WORKSPACE,
  REPORT_MAX_SUMMARY_CHARS,
  REPORT_MAX_TITLE_CHARS,
  type ReportCreatedBy,
  type ReportMetadata,
} from "../../shared/reports.ts";
import type { FeatureName } from "../features/names.ts";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import { reportStore, type ReportStore } from "./repository.ts";
import { reportTemplateStore, type ReportTemplateStore } from "./templateRepository.ts";
import { reportNotFoundError, templateNotFoundError } from "./messages.ts";
import { SANITIZER_VERSION, sanitizeReportHtml } from "./sanitize.ts";
import { captureReportEvent } from "./telemetry.ts";

// Reports: the HTML documents the assistant writes for a workspace. Every caller
// (the assistant tool, the customer routes, a future generate flow) comes
// through here, so the caps and the refusal copy exist once. Authorization is
// NOT done here — the caller has already authorized `brandKey` and every query
// is scoped to it.

const counts = new Intl.NumberFormat("en-US");
const formatCount = (value: number) => counts.format(value);

// The over-size refusal prints the actual size and the limit side by side, so
// they must never round to the same number: 500,001 bytes reading "500 KB; the
// limit is 500 KB" tells the writer to shrink by nothing. Round the actual size
// up and the limit down.
const kbUp = (bytes: number) => `${formatCount(Math.ceil(bytes / 1000))} KB`;
const kbDown = (bytes: number) => `${formatCount(Math.floor(bytes / 1000))} KB`;
const mb = (bytes: number) => `${formatCount(Math.round(bytes / 1_000_000))} MB`;

const htmlBytes = (html: string) => new TextEncoder().encode(html).length;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The seams a test may replace. Production callers pass only `admin`.
 *
 * - `store` / `templates` are the persistence interfaces (memoryStore.ts in
 *   tests, Supabase in production).
 * - `isFeatureEnabled` is F01's flag read, injected so a test does not depend on
 *   environment defaults.
 * - `now` is the clock for the 30-day view window; nothing else in this module
 *   reads a clock (timestamps come from Postgres).
 */
export type ReportServiceDeps = {
  store?: ReportStore;
  templates?: ReportTemplateStore;
  isFeatureEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  now?: () => Date;
};

type SaveReportParams = {
  brandKey: string;
  reportId?: string;
  title: string;
  summary: string;
  html: string;
  skill?: string;
  skillVersion?: string;
  templateId?: string;
  sessionId?: string;
  /** Client label, stamped by the server. Never taken from the model. */
  createdBy: ReportCreatedBy;
  /** From the authenticated context, and nowhere else. */
  createdByUserId: string;
};

export type SaveReportResult = {
  reportId: string;
  title: string;
  created: boolean;
  htmlBytes: number;
  sanitized: { changed: boolean; removedTags: string[] };
};

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23505";
}

function tooLarge(bytes: number): AppError {
  return new AppError(
    400,
    "report_too_large",
    `Report is ${kbUp(bytes)}; the limit is ${kbDown(REPORT_MAX_HTML_BYTES)}. Inlined images are the usual cause. Remove them and save again.`
  );
}

/**
 * Create-or-update in one call. Everything is validated before anything is
 * written, so a rejected save leaves the stored report untouched — there is no
 * version history, and a half-written overwrite is unrecoverable.
 *
 * The order is F23 §6.2.3 step for step: title, summary, input ceiling,
 * structure, sanitised size, template, report, title clash, create cap, byte
 * ceiling, write. A caller can rely on the first failing check being the one it
 * hears about.
 */
export async function saveReport(
  admin: SupabaseClient,
  params: SaveReportParams,
  deps?: ReportServiceDeps
): Promise<SaveReportResult> {
  const store = deps?.store ?? reportStore(admin);
  const templates = deps?.templates ?? reportTemplateStore(admin);
  const { brandKey } = params;

  // 1. Title (trimmed: "  " is not a title).
  const title = params.title.trim();
  if (title.length === 0) {
    throw new AppError(400, "title_required", "Give the report a title.");
  }
  if (title.length > REPORT_MAX_TITLE_CHARS) {
    throw new AppError(
      400,
      "title_too_long",
      `Title is ${formatCount(title.length)} characters; the limit is ${formatCount(REPORT_MAX_TITLE_CHARS)}. Shorten it and save again.`
    );
  }

  // 2. Summary (trimmed, and empty is a refusal: a report with no verdict is
  // not a report).
  const summary = params.summary.trim();
  if (summary.length === 0) {
    throw new AppError(
      400,
      "summary_required",
      "Add a one-line summary with the verdict, the top action and the key numbers."
    );
  }
  if (summary.length > REPORT_MAX_SUMMARY_CHARS) {
    throw new AppError(
      400,
      "summary_too_long",
      `Summary is ${formatCount(summary.length)} characters; the limit is ${formatCount(REPORT_MAX_SUMMARY_CHARS)}. Shorten it and save again.`
    );
  }

  // 3. The input ceiling, before the parser sees the document.
  const inputBytes = htmlBytes(params.html);
  if (inputBytes > REPORT_MAX_INPUT_BYTES) throw tooLarge(inputBytes);

  // 4. The cheap structural check, not an HTML parser: models have stopped
  // mid-document with no error, and update-in-place would silently destroy the
  // previous good report.
  const trimmedHtml = params.html.trim().toLowerCase();
  if (!trimmedHtml.includes("<html") || !trimmedHtml.endsWith("</html>")) {
    throw new AppError(
      400,
      "report_incomplete",
      "The HTML has no closing </html>; the writer stopped early. Write the whole document and save again."
    );
  }

  // 5. Sanitise, then measure what will actually be stored.
  const sanitized = sanitizeReportHtml(params.html);
  const storedBytes = htmlBytes(sanitized.html);
  if (storedBytes > REPORT_MAX_HTML_BYTES) throw tooLarge(storedBytes);

  // 6. A template the caller names must belong to this workspace. A malformed
  // uuid cannot be a stored row, so it takes the same refusal without a query.
  if (params.templateId !== undefined) {
    const template =
      UUID_PATTERN.test(params.templateId) && (await templates.getTemplate(brandKey, params.templateId));
    if (!template) throw templateNotFoundError(params.templateId);
  }

  // 7. An update must name a report in this workspace.
  let existing: ReportMetadata | null = null;
  if (params.reportId !== undefined) {
    existing =
      UUID_PATTERN.test(params.reportId) ? await store.getReport(brandKey, params.reportId) : null;
    if (!existing) throw reportNotFoundError(params.reportId, { save: true });
  }

  // 8. Titles are unique within a workspace, which keeps the duplicate pointer
  // below unambiguous. A rename clears the same bar as a create.
  const clash = await store.findReportByTitle(brandKey, title);
  if (clash && clash.id !== existing?.id) {
    throw new AppError(
      409,
      "report_title_taken",
      `A report titled '${clash.title}' exists (id ${clash.id}). Pass reportId to update it, or change the title.`
    );
  }

  // 9. The create cap. Updates are exempt: a workspace at the cap can still fix
  // the reports it has.
  if (!existing) {
    const reportCount = await store.countReports(brandKey);
    if (reportCount >= REPORT_MAX_PER_WORKSPACE) {
      throw new AppError(
        409,
        "report_limit",
        `This workspace has ${formatCount(REPORT_MAX_PER_WORKSPACE)} reports, the limit. Delete one from the Reports page.`
      );
    }
  }

  // 10. The byte ceiling, checked on updates net of the document being
  // replaced: an update that grows a report is the other way to add bytes.
  const usage = await store.workspaceUsage(brandKey);
  if (usage.totalBytes - (existing?.sizeBytes ?? 0) + storedBytes > REPORT_MAX_BYTES_PER_WORKSPACE) {
    throw new AppError(
      409,
      "report_storage_limit",
      `This workspace is storing ${mb(usage.totalBytes)} of reports, the limit. Delete reports you no longer need from the Reports page.`
    );
  }

  // 11. Write. An omitted skill, skill version or template keeps the stored one;
  // attribution and sharing are never touched by a content save.
  const skill = params.skill ?? existing?.skill ?? null;
  const skillVersion = params.skillVersion ?? existing?.skillVersion ?? null;
  const templateId = params.templateId ?? existing?.templateId ?? null;
  const reportId = existing?.id ?? randomUUID();

  try {
    if (existing) {
      await store.updateReportContent({
        reportId,
        brandKey,
        title,
        summary,
        html: sanitized.html,
        skill,
        skillVersion,
        templateId,
        sizeBytes: storedBytes,
        sanitizerVersion: SANITIZER_VERSION,
      });
    } else {
      await store.insertReport({
        id: reportId,
        brandKey,
        title,
        summary,
        html: sanitized.html,
        skill,
        skillVersion,
        templateId,
        sessionId: params.sessionId ?? null,
        createdBy: params.createdBy,
        createdByUserId: params.createdByUserId,
        sizeBytes: storedBytes,
        sanitizerVersion: SANITIZER_VERSION,
      });
    }
  } catch (error) {
    // The unique index is the real guard: two saves can both pass step 8 at the
    // same instant. Name the row that won.
    if (isUniqueViolation(error)) {
      const raced = await store.findReportByTitle(brandKey, title);
      throw new AppError(
        409,
        "report_title_taken",
        `A report titled '${raced?.title ?? title}' exists (id ${raced?.id ?? "unknown"}). Pass reportId to update it, or change the title.`
      );
    }
    if (isAppError(error)) throw error;
    throw new AppError(503, "reports_unavailable", "Reports are unavailable. Please retry.");
  }

  const created = existing === null;
  captureReportEvent("report:saved", {
    skill,
    used_template: templateId !== null,
    size_bytes: storedBytes,
    is_update: !created,
    sanitized_changed: sanitized.changed,
    source: params.createdBy,
  });

  return {
    reportId,
    title,
    created,
    htmlBytes: storedBytes,
    sanitized: { changed: sanitized.changed, removedTags: sanitized.removedTags },
  };
}

/** Metadata only, newest update first. `remaining` is the room left under the cap. */
export async function listReports(
  admin: SupabaseClient,
  input: { brandKey: string; limit: number; offset: number },
  deps?: ReportServiceDeps
): Promise<{ reports: ReportMetadata[]; totalCount: number; remaining: number }> {
  const store = deps?.store ?? reportStore(admin);
  const [reports, totalCount] = await Promise.all([
    store.listReports(input),
    store.countReports(input.brandKey),
  ]);
  return {
    reports,
    totalCount,
    remaining: Math.max(0, REPORT_MAX_PER_WORKSPACE - totalCount),
  };
}

export async function getReport(
  admin: SupabaseClient,
  brandKey: string,
  reportId: string,
  deps?: ReportServiceDeps
): Promise<ReportMetadata> {
  const store = deps?.store ?? reportStore(admin);
  const report = UUID_PATTERN.test(reportId) ? await store.getReport(brandKey, reportId) : null;
  if (!report) throw reportNotFoundError(reportId);
  return report;
}

/** The only reader of the `html` column, and it reads the metadata with it. */
export async function getReportWithHtml(
  admin: SupabaseClient,
  brandKey: string,
  reportId: string,
  deps?: ReportServiceDeps
): Promise<{ report: ReportMetadata; html: string }> {
  const store = deps?.store ?? reportStore(admin);
  const row = UUID_PATTERN.test(reportId) ? await store.getReportWithHtml(brandKey, reportId) : null;
  if (!row) throw reportNotFoundError(reportId);
  const { html, ...report } = row;
  return { report, html };
}

export async function deleteReport(
  admin: SupabaseClient,
  brandKey: string,
  reportId: string,
  deps?: ReportServiceDeps
): Promise<void> {
  const store = deps?.store ?? reportStore(admin);
  const deleted = UUID_PATTERN.test(reportId) ? await store.deleteReport(brandKey, reportId) : false;
  if (!deleted) throw reportNotFoundError(reportId);
}

export type ShareReportResult = { shareToken: string; sharedAt: string };

/**
 * Mints the public link, or returns the existing one. Idempotent on purpose:
 * the modal's toggle can be flipped twice by a double click or a retried
 * mutation, and a second mint would silently break the link the user just
 * copied.
 */
export async function shareReport(
  admin: SupabaseClient,
  input: { brandKey: string; reportId: string; userId: string },
  deps?: ReportServiceDeps
): Promise<ShareReportResult> {
  const flag = deps?.isFeatureEnabled ?? isFeatureEnabledDefault;
  // Refused here rather than only hidden in the UI: the server is the trust
  // boundary. A token minted while sharing is off is a link that silently does
  // nothing, and the user would have copied it believing otherwise.
  if (!(await flag("report_sharing", input.brandKey))) {
    throw new AppError(404, "feature_unavailable", "Public links are not available for this workspace.");
  }

  const report = await getReport(admin, input.brandKey, input.reportId, deps);
  const store = deps?.store ?? reportStore(admin);
  const minted = await store.mintShareToken({
    brandKey: input.brandKey,
    reportId: report.id,
    token: mintShareToken(),
    userId: input.userId,
  });
  if (!minted.shareToken || !minted.sharedAt) {
    throw new AppError(503, "reports_unavailable", "Reports are unavailable. Please retry.");
  }
  // Another publisher may have won after our read; only the request that
  // created the link emits the event.
  if (minted.created) {
    captureReportEvent("report:shared", { skill: report.skill });
  }
  return { shareToken: minted.shareToken, sharedAt: minted.sharedAt };
}

/** Revokes the link by nulling the token. A second call is a no-op. */
export async function unshareReport(
  admin: SupabaseClient,
  input: { brandKey: string; reportId: string; userId: string },
  deps?: ReportServiceDeps
): Promise<{ shareToken: null; sharedAt: null }> {
  const report = await getReport(admin, input.brandKey, input.reportId, deps);
  const store = deps?.store ?? reportStore(admin);
  const changed = await store.clearShareToken({ brandKey: input.brandKey, reportId: report.id });
  if (changed) {
    captureReportEvent("report:unshared", { skill: report.skill });
  }
  return { shareToken: null, sharedAt: null };
}

/**
 * Browser views of the current public link over the last 30 UTC days, today
 * included. A private report has no link to count, so a blank token answers 0
 * rather than asking a question with no answer.
 */
export async function viewsLast30Days(
  admin: SupabaseClient,
  input: { brandKey: string; reportId: string; shareToken: string },
  deps?: ReportServiceDeps
): Promise<number> {
  const token = String(input.shareToken ?? "").trim();
  if (!token) return 0;
  const pseudonym = await sharePseudonym(token);
  const now = deps?.now ? deps.now() : new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceDay = new Date(midnight - 29 * 86_400_000).toISOString().slice(0, 10);
  const store = deps?.store ?? reportStore(admin);
  return store.sumBrowserViews({
    brandKey: input.brandKey,
    reportId: input.reportId,
    pseudonym,
    sinceDay,
  });
}
