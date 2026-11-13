"use client";

import { EmptyState } from "@/components/app/EmptyState";
import { usePortal } from "@/components/portal/PortalShell";
import { UsagePage } from "@/components/portal/usage/UsagePage";

export default function UsageRoutePage() {
  const { brandKey, features } = usePortal();

  if (features && features.usage_page === false) {
    return <EmptyState title="Usage is not available for this workspace yet." />;
  }

  return <UsagePage brandKey={brandKey || ""} />;
}
