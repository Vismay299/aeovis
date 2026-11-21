"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/ProjectContextPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useRef } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { SectionNav } from "@/components/app/navigation/SectionNav";
import { trackEvent } from "@/shared/telemetry/client";
import type { ProjectContext } from "@/shared/project-context";
import { BrandIdentityCard } from "./BrandIdentityCard";
import { CompetitorsSection } from "./CompetitorsSection";
import { CustomSections } from "./CustomSections";
import { KeyPagesSection } from "./KeyPagesSection";
import { ProseSections } from "./ProseSections";
import { ResearchLog } from "./ResearchLog";

/** The page's sections, in order, for the header section pill. */
const CONTEXT_SECTIONS = [
  { id: "context-names", label: "Names" },
  { id: "context-business", label: "Business" },
  { id: "context-competitors", label: "Competitors" },
  { id: "context-key-pages", label: "Key pages" },
  { id: "context-custom", label: "Custom sections" },
  { id: "context-research", label: "Research log" },
] as const;

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

      {/* A long page with clear sections: the pill follows the one in view. */}
      <SectionNav label="Context sections" sections={CONTEXT_SECTIONS} />

      <section id="context-names" className="scroll-mt-16">
        <BrandIdentityCard brandIdentity={context.brandIdentity} />
      </section>

      <section id="context-business" className="scroll-mt-16">
        <ProseSections
          brandKey={brandKey}
          sections={context.sections}
          missingSections={context.missingSections}
          currentUserId={currentUserId}
        />
      </section>

      <section id="context-competitors" className="scroll-mt-16">
        <CompetitorsSection
          brandKey={brandKey}
          competitors={context.competitors}
          currentUserId={currentUserId}
        />
      </section>

      <section id="context-key-pages" className="scroll-mt-16">
        <KeyPagesSection
          brandKey={brandKey}
          keyPages={context.keyPages}
          currentUserId={currentUserId}
        />
      </section>

      <section id="context-custom" className="scroll-mt-16">
        <CustomSections
          brandKey={brandKey}
          customSections={context.customSections}
          currentUserId={currentUserId}
        />
      </section>

      <section id="context-research" className="scroll-mt-16">
        <ResearchLog
          brandKey={brandKey}
          researchLog={context.researchLog}
          currentUserId={currentUserId}
        />
      </section>
    </div>
  );
}
