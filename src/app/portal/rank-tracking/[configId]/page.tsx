"use client";

import { Suspense, use } from "react";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { RankTrackingDomainDetail } from "@/components/portal/rank-tracking/RankTrackingDomainDetail";

export default function RankTrackingConfigPage({
  params,
}: {
  params: Promise<{ configId: string }> | { configId: string };
}) {
  const unwrapped = "then" in params ? use(params) : params;
  const configId = unwrapped?.configId ?? "";

  return (
    <Suspense fallback={<SkeletonPage />}>
      <RankTrackingDomainDetail configId={configId} />
    </Suspense>
  );
}
