// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchLoadingState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function KeywordResearchLoadingState() {
  return <div className="space-y-4" aria-busy="true" aria-label="Loading keyword research">
    <Skeleton className="h-24 w-full" />
    <div className="grid gap-4 xl:grid-cols-5"><Skeleton className="h-[28rem] xl:col-span-3" /><Skeleton className="h-[28rem] xl:col-span-2" /></div>
  </div>;
}
