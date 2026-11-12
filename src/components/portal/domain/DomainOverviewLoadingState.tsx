"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainOverviewLoadingState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { SkeletonTableRows } from "@/components/app/SkeletonPresets";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function DomainOverviewLoadingState() {
  return (
    <Card className="gap-0 py-0" aria-busy="true">
      <div className="px-4 pt-4 pb-3">
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="px-4 pb-4">
        <div className="w-full max-w-xl rounded-lg border border-border p-3">
          <SkeletonTableRows rows={3} columns={2} />
        </div>
      </div>
      <div className="px-4 pb-4">
        <div className="space-y-4 rounded-xl border border-border p-4">
          <Skeleton className="h-6 w-48" />
          <SkeletonTableRows />
        </div>
      </div>
    </Card>
  );
}
