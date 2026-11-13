"use client";

import { Suspense } from "react";
import { usePortal } from "@/components/portal/PortalShell";
import { SavedKeywordsPage } from "@/components/portal/keywords/saved/SavedKeywordsPage";
import { SkeletonTableRows } from "@/components/app/SkeletonPresets";
import { Card } from "@/components/ui/card";

export default function SavedKeywordsRoute() {
  const { brandKey } = usePortal();

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
      {/* The page stays mounted across a workspace switch (the saved-keywords
          nav item is the deepest match, so the switcher does not navigate).
          Keying by brandKey remounts it, clearing the selection, both modal
          targets, the tag manager's pending set and the refresh job/dialog. */}
      <SavedKeywordsPage key={brandKey} />
    </Suspense>
  );
}

