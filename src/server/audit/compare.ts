import { AppError } from "../../shared/http/errors.ts";
import { AUDIT_ISSUE_TYPES } from "../../shared/audit-issues.ts";
import { getOwnedAudit } from "./results.ts";

const NOT_COMPARABLE = "Choose two finished audits of the same site.";

type AuditCompareMeta = {
  id: string;
  start_host: string;
  status: string;
  created_at: string;
  pages_crawled: number | string | null;
  max_pages: number | string | null;
  crawl_completed: boolean | null;
};

function finished(status: string): boolean {
  return status !== "queued" && status !== "running";
}

function coverageDiffers(basePages: number, headPages: number, baseComplete: boolean, headComplete: boolean): boolean {
  if (!baseComplete || !headComplete) return true;
  // Use the larger count for a symmetric comparison; warn only when the ratio is strictly above 10%.
  const largest = Math.max(basePages, headPages);
  return largest > 0 && Math.abs(basePages - headPages) / largest > 0.1;
}

export async function getAuditCompare(admin: any, brandKey: string, baseId: string, headId: string): Promise<any> {
  const columns = "id,start_host,status,created_at,pages_crawled,max_pages,crawl_completed";
  const [base, head] = await Promise.all([
    getOwnedAudit(admin, brandKey, baseId, columns) as Promise<AuditCompareMeta>,
    getOwnedAudit(admin, brandKey, headId, columns) as Promise<AuditCompareMeta>,
  ]);

  if (!finished(base.status) || !finished(head.status) || base.start_host !== head.start_host) {
    throw new AppError(422, "audits_not_comparable", NOT_COMPARABLE);
  }

  const { data, error } = await admin.rpc("site_audit_compare", {
    p_brand_key: brandKey,
    p_base: baseId,
    p_head: headId,
    p_sample: 100,
  });
  if (error) throw error;

  const basePages = Number(base.pages_crawled ?? 0);
  const headPages = Number(head.pages_crawled ?? 0);
  const baseComplete = Boolean(base.crawl_completed);
  const headComplete = Boolean(head.crawl_completed);
  const differs = coverageDiffers(basePages, headPages, baseComplete, headComplete);
  const warning = differs
    ? {
        code: "coverage_differs",
        message: `These audits crawled different numbers of pages (${basePages} and ${headPages}), so some changes may come from coverage, not fixes.`,
      }
    : null;
  const rows = (data ?? []).map((row: any) => ({
    issueType: row.issue_type,
    severity: AUDIT_ISSUE_TYPES[row.issue_type as keyof typeof AUDIT_ISSUE_TYPES]?.severity ?? row.severity,
    basePages: Number(row.base_pages ?? 0),
    headPages: Number(row.head_pages ?? 0),
    newPages: Array.isArray(row.new_pages) ? row.new_pages.slice(0, 100) : [],
    fixedPages: Array.isArray(row.fixed_pages) ? row.fixed_pages.slice(0, 100) : [],
  })).sort((a: any, b: any) => a.issueType.localeCompare(b.issueType));

  return {
    host: base.start_host,
    base: {
      id: base.id,
      createdAt: base.created_at,
      pagesCrawled: basePages,
      maxPages: Number(base.max_pages ?? 0),
      crawlCompleted: baseComplete,
    },
    head: {
      id: head.id,
      createdAt: head.created_at,
      pagesCrawled: headPages,
      maxPages: Number(head.max_pages ?? 0),
      crawlCompleted: headComplete,
    },
    comparable: !differs,
    warnings: warning ? [warning] : [],
    rows,
  };
}
