"use client";

import { Suspense } from "react";
import { SavedKeywordsPage } from "@/components/portal/keywords/saved/SavedKeywordsPage";
import { SkeletonTableRows } from "@/components/app/SkeletonPresets";
import { Card } from "@/components/ui/card";

export default function SavedKeywordsRoute() {
  return (
    <Suspense
      fallback={
        <div className="p-6">
          <Card className="p-4">
            <SkeletonTableRows rows={8} columns={8} />
          </Card>
        </div>
      }
    >
      <SavedKeywordsPage />
    </Suspense>
  );
}
