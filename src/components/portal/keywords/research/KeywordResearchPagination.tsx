// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchPagination.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Button } from "@/components/ui/button";

export function KeywordResearchPagination({ page, pageSize, total, pageEnds, onPage, onPageSize }: {
  page: number;
  pageSize: number;
  total: number;
  pageEnds: number[];
  onPage: (page: number) => void;
  onPageSize: (size: 50 | 100 | 300 | 500) => void;
}) {
  const pages = Math.max(1, pageEnds.length);
  const start = page <= 1 ? 0 : pageEnds[page - 2] ?? total;
  const end = pageEnds[page - 1] ?? total;
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-3 text-sm text-muted-foreground">
    <span>{total ? `${start + 1}-${end} of ${total}` : "0 results"}</span>
    <div className="flex items-center gap-2">
      <label>Rows per page <select className="rounded border border-input bg-background p-1" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value) as 50 | 100 | 300 | 500)}>{[50, 100, 300, 500].map((size) => <option key={size}>{size}</option>)}</select></label>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">Previous</Button>
      <span>Page {page} of {pages}</span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">Next</Button>
    </div>
  </div>;
}
