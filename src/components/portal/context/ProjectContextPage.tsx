"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/ProjectContextPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useRef } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { trackEvent } from "@/shared/telemetry/client";
import type { ProjectContext } from "@/shared/project-context";
import { BrandIdentityCard } from "./BrandIdentityCard";
import { CompetitorsSection } from "./CompetitorsSection";
import { CustomSections } from "./CustomSections";
import { KeyPagesSection } from "./KeyPagesSection";
import { ProseSections } from "./ProseSections";
import { ResearchLog } from "./ResearchLog";

export function ProjectContextPage({
  brandKey,
  context,
  currentUserId,
}: {
  brandKey: string;
  context: ProjectContext;
  currentUserId?: string | null;
}) {
  const viewedBrandRef = useRef<string | null>(null);
  useEffect(() => {
    if (viewedBrandRef.current === brandKey) return;
    viewedBrandRef.current = brandKey;
    trackEvent("project_context:viewed", {});
  }, [brandKey]);

  return (
    // key remounts the whole page when the workspace switches under it, so no
    // draft, open form, or edit state can carry over to another workspace.
    <div key={brandKey} className="max-w-3xl space-y-8">
      <PageHeader
        title="Context"
        description={`What Perceev knows about ${context.brandIdentity.displayName}.`}
      />

      <p className="text-sm text-muted-foreground">
        Question setup, the assistant and Content Studio read this before they
        work, and some of them write back what they learn. Correct anything that
        looks wrong.
      </p>

      <BrandIdentityCard brandIdentity={context.brandIdentity} />

      <ProseSections
        brandKey={brandKey}
        sections={context.sections}
        missingSections={context.missingSections}
        currentUserId={currentUserId}
      />

      <CompetitorsSection
        brandKey={brandKey}
        competitors={context.competitors}
        currentUserId={currentUserId}
      />

      <KeyPagesSection
        brandKey={brandKey}
        keyPages={context.keyPages}
        currentUserId={currentUserId}
      />

      <CustomSections
        brandKey={brandKey}
        customSections={context.customSections}
        currentUserId={currentUserId}
      />

      <ResearchLog
        brandKey={brandKey}
        researchLog={context.researchLog}
        currentUserId={currentUserId}
      />
    </div>
  );
}
