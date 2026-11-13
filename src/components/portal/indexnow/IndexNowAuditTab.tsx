"use client";

// F19 phase 3 — compact IndexNow tab hosted by the Site Audit area.

import { IndexNowPanel } from "./IndexNowPanel";

export function IndexNowAuditTab({
  brandKey,
  auditId,
}: {
  brandKey: string;
  auditId: string | null;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Submit pages this audit found that you have just added or fixed.
        Don&apos;t submit unchanged pages.
      </p>
      <IndexNowPanel source="audit" sourceRef={auditId ?? undefined} />
    </div>
  );
}

export default IndexNowAuditTab;