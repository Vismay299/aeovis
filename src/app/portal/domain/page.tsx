"use client";

import { EmptyState } from "@/components/app/EmptyState";
import { usePortal } from "@/components/portal/PortalShell";
import { DomainOverviewPage } from "@/components/portal/domain/DomainOverviewPage";

export default function DomainRoutePage() {
  const { brandKey, brand, features } = usePortal();

  if (features && features.domain_research === false) {
    return (
      <EmptyState
        title="This page is not available for your workspace yet."
        description="Ask Perceev support to turn on domain research."
      />
    );
  }

  const marketBrand = brand
    ? {
        website_host: brand.website
          ? brand.website.replace(/^https?:\/\//, "").split("/")[0]
          : null,
      }
    : null;

  return (
    <DomainOverviewPage
      brandKey={brandKey || ""}
      brand={marketBrand}
      hasProjectMemory={features?.project_memory !== false}
      canSaveKeywords={features?.keyword_research !== false}
    />
  );
}
