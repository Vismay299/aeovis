// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingDomainList.tsx:55-328
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { usePortal } from "@/components/portal/PortalShell";
import { PageFrame } from "@/components/app/PageFrame";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { NotFound } from "@/components/app/NotFound";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { RankTrackingDomainList } from "./RankTrackingDomainList";
import { RankTrackingConfigDialog } from "./RankTrackingConfigDialog";
import type { RankTrackerSummary } from "./hooks/useRankTrackers";

export function RankTrackingPage() {
  const { brandKey, brand, features } = usePortal();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] =
    useState<RankTrackerSummary | null>(null);

  if (features === null) return <SkeletonPage />;
  if (features?.rank_tracking !== true) return <NotFound />;
  if (!brandKey) {
    return (
      <EmptyState
        title="Workspace required"
        description="Select a workspace to use Rank Tracking."
      />
    );
  }

  const openCreate = () => {
    setEditingConfig(null);
    setDialogOpen(true);
  };

  return (
    <PageFrame className="min-w-0 overflow-x-hidden">
      <PageHeader
        title="Rank Tracking"
        description="Track where your site ranks on Google for the searches that matter, and which of them show an AI Overview."
      />
      <RankTrackingDomainList brandKey={brandKey} onAddDomain={openCreate} />
      {dialogOpen && (
        <RankTrackingConfigDialog
          brandKey={brandKey}
          website={brand?.website ?? null}
          existingConfig={editingConfig}
          onClose={() => {
            setDialogOpen(false);
            setEditingConfig(null);
          }}
          onSaved={() => {
            setDialogOpen(false);
            setEditingConfig(null);
          }}
        />
      )}
    </PageFrame>
  );
}
