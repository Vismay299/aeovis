"use client";

import { usePortal } from "@/components/portal/PortalShell";
import { EmptyState } from "@/components/app/EmptyState";
import { LocalSeoPage } from "@/components/portal/local/LocalSeoPage";

export default function LocalPageRoute() {
  const { brandKey, brand, features } = usePortal();

  if (features && features.local_seo === false) {
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
