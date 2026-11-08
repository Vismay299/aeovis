// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/issues/multipage.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { AuditStore } from "../store.ts";
import type { DetectedIssue } from "./pageReporters.ts";
import {
  findDuplicates,
  findRedirectChainsAndLoops,
  findHreflangReturnLinks,
  type SlimPage,
} from "./multipageChecks.ts";

/**
 * Runs cross-page checks across all crawled pages of an audit.
 * Reads pages in batches of 1,000 and applies duplicate, redirect, and hreflang reciprocal checks.
 */
export async function runMultipageChecks({
  auditId,
  store,
}: {
  auditId: string;
  store: AuditStore;
}): Promise<{ issues: DetectedIssue[]; hasUnreadShells: boolean }> {
  const shells = await store.shellPageIds(auditId);
  const pages: SlimPage[] = [];
  let afterId: string | null = null;

  while (true) {
    const batch = await store.listSlimPages(auditId, afterId, 1000);
    if (batch.length === 0) break;
    for (const page of batch) {
      if (shells.has(page.id)) {
        page.javascriptShell = true;
      }
      pages.push(page);
    }
    afterId = batch[batch.length - 1].id;
    if (batch.length < 1000) break;
  }

  const issues: DetectedIssue[] = [
    ...findDuplicates(pages),
    ...findRedirectChainsAndLoops(pages),
    ...findHreflangReturnLinks(pages as any),
  ];

  const hasUnreadShells = shells.size > 0;
  return { issues, hasUnreadShells };
}
