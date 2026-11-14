"use client";

import { Suspense } from "react";
import { RankTrackingPage } from "@/components/portal/rank-tracking/RankTrackingPage";
import { SkeletonPage } from "@/components/app/SkeletonPresets";

export default function RankTrackingRoutePage() {
  return (
    <Suspense fallback={<SkeletonPage />}>
      <RankTrackingPage />
    </Suspense>
  );
}
