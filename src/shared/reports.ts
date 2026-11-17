// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/reports.ts
//   src/types/schemas/report-templates.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// Shared vocabulary for reports and report templates. The caps and the wire
// shapes are defined once here so the service, the tools and the pages cannot
// drift apart.
//
// Perceev adaptation: the upstream caps are per project (10,000 reports) and per
// organisation (5 GB). Perceev's unit is the workspace (`brand_key`), so both
// collapse into one pair of per-workspace caps (2,000 reports, 250,000,000
// bytes). A workspace is the only tenancy boundary a customer has here.

/**
 * UTF-8 byte cap on a stored document, measured with TextEncoder (not
 * `String.length`, which counts UTF-16 code units and understates multi-byte
 * content).
 */
export const REPORT_MAX_HTML_BYTES = 500_000;

/**
 * The refusal line for the HTML a caller hands in, before sanitising. Sanitising
 * removes hostile markup, so a document far over the stored cap is refused
 * before it is parsed: a megabyte of scripts is a sign the writer ignored the
 * instructions, not a document to clean up.
 */
export const REPORT_MAX_INPUT_BYTES = 1_000_000;

/** Runaway-storage guard per workspace, enforced on create only. */
export const REPORT_MAX_PER_WORKSPACE = 2_000;

/**
 * Runaway-storage guard on the bytes a workspace stores, checked on creates and
 * updates net of the document an update replaces.
 */
export const REPORT_MAX_BYTES_PER_WORKSPACE = 250_000_000;

/** Page size for a list read when the caller does not ask for one. */
export const REPORT_DEFAULT_LIST_LIMIT = 20;

/** Ceiling on a single list page, for the assistant tool's payload budget. */
export const REPORT_MAX_LIST_LIMIT = 50;

/** The Reports page shows the most recent 100. */
export const REPORT_APP_LIST_LIMIT = 100;

export const REPORT_MAX_TITLE_CHARS = 120;
export const REPORT_MAX_SUMMARY_CHARS = 2_500;

// Report templates: the named briefs the assistant follows when writing a
// report.

export const REPORT_TEMPLATE_MAX_PER_WORKSPACE = 10;
export const REPORT_TEMPLATE_MAX_NAME_CHARS = 80;
export const REPORT_TEMPLATE_MAX_DESCRIPTION_CHARS = 200;
/** A brief, not a document. Ten at the cap is the 30 KB list worst case. */
export const REPORT_TEMPLATE_MAX_INSTRUCTIONS_CHARS = 3_000;

/** How a report came to exist. `created_by` in the database, and never re-stamped. */
export type ReportCreatedBy = "assistant" | "app";

/**
 * Everything a metadata read returns. `html` is deliberately absent: it is read
 * only by `getReportWithHtml` and the two document routes, so no list path can
 * pull documents into a worker's heap.
 *
 * A plain type, not a Zod schema: these rows are built by the repository from
 * its own column selection, so there is no trust boundary here to validate.
 */
export type ReportMetadata = {
  id: string;
  brandKey: string;
  title: string;
  summary: string;
  skill: string | null;
  skillVersion: string | null;
  /** The report template followed, or null. Unresolved: the name is looked up
   * workspace-scoped by the reader that needs it. */
  templateId: string | null;
  createdBy: ReportCreatedBy;
  /** From the authenticated context, and nowhere else. Null once the user is deleted. */
  createdByUserId: string | null;
  /** UTF-8 byte length of the stored document. */
  sizeBytes: number;
  /** The sanitiser version that produced the stored document. */
  sanitizerVersion: number;
  /**
   * The public share token, or null when the report is not shared. The app
   * builds the link from it (`<origin>/s/<token>`) rather than storing a URL,
   * so the same row works on every deployment.
   */
  shareToken: string | null;
  /** When the current share token was minted, or null when not shared. */
  sharedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A list row: metadata without the summary or the share capability (the list
 * response in §6.5 carries neither), plus the two display names the page needs.
 * `skillTitle` and `templateName` are resolved by the reader; a missing skill or
 * a deleted template reads as null, and the page falls back to the other.
 */
export type ReportListItem = Omit<
  ReportMetadata,
  "summary" | "shareToken" | "sharedAt" | "createdByUserId"
> & {
  skillTitle: string | null;
  templateName: string | null;
};

/**
 * A detail row: the list row plus what only the detail read knows. `views30d` is
 * null when the report is not shared (the question was not asked); `chatPath` is
 * non-null only when the writing session still exists and belongs to the caller.
 */
export type ReportDetail = ReportListItem & {
  shareToken: string | null;
  sharedAt: string | null;
  views30d: number | null;
  chatPath: string | null;
};

/** A stored template. Column-for-column with `public.report_templates`. */
export type ReportTemplate = {
  id: string;
  brandKey: string;
  name: string;
  description: string;
  instructions: string;
  createdBy: ReportCreatedBy;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};
