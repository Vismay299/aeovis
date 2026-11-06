// Client-safe audit status, phase enums, labels, and error copy for Perceev site audit.

export const AUDIT_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const;

export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const AUDIT_PHASES = [
  "queued",
  "starting",
  "discovery",
  "crawling",
  "lighthouse",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AuditPhase = (typeof AUDIT_PHASES)[number];

export const PHASE_LABELS = {
  queued: "Queued",
  starting: "Starting",
  discovery: "Discovery",
  crawling: "Crawling",
  lighthouse: "Lighthouse",
  finalizing: "Finalizing",
} as const;

export const AUDIT_CRAWLER_USER_AGENT =
  "Mozilla/5.0 (compatible; PerceevAudit/1.0; +https://perceev.xyz)";

export const AUDIT_ROBOTS_TOKEN = "PerceevAudit";

export const AUDIT_ERROR_COPY: Record<string, { title: string; body: string }> = {
  step_timeout: {
    title: "A crawl step timed out",
    body: "The site took longer to answer than the audit time limit allowed. Run a new audit with fewer pages to try again.",
  },
  step_attempts_exhausted: {
    title: "A crawl step failed repeatedly",
    body: "A step failed after retrying. Run a new audit to try again.",
  },
  billed_step_interrupted: {
    title: "A paid step stopped before completion",
    body: "A paid step was interrupted. Run a new audit to try again.",
  },
  db_error: {
    title: "Database error during audit",
    body: "A database operation failed while saving audit progress. Run a new audit to try again.",
  },
  job_lost: {
    title: "The audit runner was lost",
    body: "The background task running this audit stopped unexpectedly. Run a new audit to try again.",
  },
  start_failed: {
    title: "Failed to start the audit",
    body: "The crawler could not initialise for this website. Check the URL and try again.",
  },
  start_url_off_site: {
    title: "Start URL redirects off-site",
    body: "Your site redirects to another host that isn't this workspace's website. Update the workspace website, or audit that site from a workspace that owns it.",
  },
  url_blocked: {
    title: "URL blocked for security",
    body: "The requested URL or a redirect resolved to a private or restricted network address.",
  },
  url_unreachable: {
    title: "Website is unreachable",
    body: "The website could not be reached over the network. Check that the site is online and try again.",
  },
  no_pages: {
    title: "No pages could be crawled",
    body: "The audit could not crawl any pages. Check robots.txt and bot-protection settings.",
  },
  cancelled: {
    title: "Audit was cancelled",
    body: "This audit was cancelled before it completed.",
  },
  unknown: {
    title: "An unexpected error occurred",
    body: "This audit stopped before it completed. Run a new audit to try again. If it keeps happening, contact Perceev support.",
  },
};
