"use client";

import { usePortal } from "@/components/portal/PortalShell";
import { EmptyState } from "@/components/app/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { LocalSeoPage } from "@/components/portal/local/LocalSeoPage";

export default function LocalPageRoute() {
  const { brandKey, brand, features } = usePortal();

  // Wait for the flags: rendering before they land fired business API calls
  // (404 feature_unavailable) and showed the page to workspaces without it.
  if (features === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (features?.local_seo !== true) {
    return (
      <EmptyState
        title="Feature unavailable"
        description="This page is not available for your workspace yet."
      />
    );
  }

  if (!brandKey) {
    return (
      <EmptyState
        title="Workspace required"
        description="Select a workspace to view Local SEO."
      />
    );
  }

  return (
    <LocalSeoPage
      brandKey={brandKey}
      workspaceDisplayName={brand?.display_name}
    />
  );
}
