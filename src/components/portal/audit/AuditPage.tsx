// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/audit/index.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the audit area shell. The page tabs come from the registry and
// are selected with `?tab=`; the panel receives the workspace and audit id.

import { Suspense, useEffect, useState } from "react";
import { z } from "zod";
import { usePortal } from "@/components/portal/PortalShell";
import { EmptyState } from "@/components/app/EmptyState";
import { NotFound } from "@/components/app/NotFound";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AUDIT_TABS, type AuditTab } from "./tabs";

const TAB_SCHEMA = z.object({ tab: z.string().optional() });
const TAB_DEFAULTS = { tab: "audit" };

/**
 * Test seam for the registry contract (F18-B09): the browser check sets this
 * global before the page boots to append F19-shaped entries. A normal visit
 * never sets it, so the shipped registry is exactly AUDIT_TABS.
 */
function injectedTabs(): AuditTab[] {
  if (typeof window === "undefined") return [];
  const raw = (window as unknown as { __PERCEEV_AUDIT_TABS__?: unknown })
    .__PERCEEV_AUDIT_TABS__;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, label, flag } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string") return [];
    return [
      {
        id,
        label,
        ...(typeof flag === "string" ? { flag } : {}),
        Panel: () => (
          <div data-testid={`injected-tab-panel-${id}`}>{`${label} panel`}</div>
        ),
      },
    ];
  });
}

export function AuditPage({ auditId }: { auditId: string | null }) {
  const { brandKey, features } = usePortal();
  const [state, setState] = useUrlSearchState(TAB_SCHEMA, TAB_DEFAULTS);
  const [extraTabs, setExtraTabs] = useState<AuditTab[]>([]);

  // After mount, so the server and the first client render agree.
  useEffect(() => {
    setExtraTabs(injectedTabs());
  }, []);

  if (features === null) return <SkeletonPage />;
  if (features?.site_audit !== true) return <NotFound />;
  if (!brandKey) {
    return (
      <EmptyState
        title="Workspace required"
        description="Select a workspace to use Site Audit."
      />
    );
  }

  const allTabs = [...AUDIT_TABS, ...extraTabs];
  const visibleTabs = allTabs.filter(
    (tab) => !tab.flag || features?.[tab.flag] === true,
  );
  const activeTab =
    visibleTabs.find((tab) => tab.id === state.tab) ?? visibleTabs[0];
  if (!activeTab) return <NotFound />;

  return (
    <div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        {visibleTabs.length > 1 ? (
          <Tabs
            value={activeTab.id}
            onValueChange={(value) => setState({ tab: value })}
          >
            <TabsList variant="line">
              {visibleTabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}

        <Suspense fallback={<SkeletonPage />}>
          <activeTab.Panel brandKey={brandKey} auditId={auditId} />
        </Suspense>
      </div>
    </div>
  );
}
