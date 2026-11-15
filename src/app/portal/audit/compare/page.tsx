"use client";

import { Suspense } from "react";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { CompareView } from "@/components/portal/audit/compare/CompareView";

export default function AuditCompareRoute() {
  return (
    <Suspense fallback={<SkeletonPage />}>
      <CompareView />
    </Suspense>
  );
}
