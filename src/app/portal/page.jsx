"use client";

import { useEffect, useState } from "react";
import { Play, PenLine } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { ScanProgressCard } from "@/components/portal/ScanProgressCard";
import { Banner, Button, PageHeader } from "@/components/portal/ui";
import GettingStarted, { buildChecklist } from "@/components/portal/overview/GettingStarted";
import KpiRow from "@/components/portal/overview/KpiRow";
import VisibilityTrend from "@/components/portal/overview/VisibilityTrend";
import RecentScans from "@/components/portal/overview/RecentScans";
import ContentStudioCard from "@/components/portal/overview/ContentStudioCard";
import { websiteHost } from "@/components/portal/overview/overviewModel";

/** true/false once the workspace's question panel is known; null while loading or unreadable. */
function useApprovedPanel(brandKey) {
  const [approved, setApproved] = useState(null);
  useEffect(() => {
    setApproved(null);
    if (!brandKey) return undefined;
    let live = true;
    fetch(`/api/customer/repairs/panel?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (live && Array.isArray(body?.items)) {
          // Same predicate POST /api/customer/scan uses before it will start a scan.
          setApproved(body.items.some((panel) => panel.artifact_key === "default" && panel.state === "approved"));
        }
      })
      .catch(() => {});
    return () => { live = false; };
  }, [brandKey]);
  return approved;
}

export default function OverviewPage() {
  const { brand, brandKey, overview, overviewError, refreshOverview, gsc, scan } = usePortal();
  const panelApproved = useApprovedPanel(brandKey);

  const name = brand?.display_name || overview?.brand?.display_name || "Your brand";
  const host = websiteHost(brand?.website || overview?.brand?.website);
  const checklist = buildChecklist({ overview, gsc, scan, panelApproved });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={host || undefined}
        title={name}
        description="How AI answer engines talk about your brand."
        actions={
          <>
            <Button icon={Play} onClick={scan.start} loading={scan.starting} disabled={scan.active}>
              Run scan
            </Button>
            <Button variant="secondary" icon={PenLine} href="/portal/content?new=1">
              New draft
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        {overviewError ? (
          <Banner
            tone="error"
            title="Overview could not load"
            action={<Button size="sm" variant="secondary" onClick={() => refreshOverview()}>Try again</Button>}
          >
            {overviewError}
          </Banner>
        ) : null}

        <ScanProgressCard showIdle={!overview?.scans?.length} />

        {overview ? <GettingStarted steps={checklist} /> : null}

        <KpiRow overview={overview} gsc={gsc} />

        <VisibilityTrend overview={overview} />

        <div className="grid gap-5 lg:grid-cols-2 items-start">
          <RecentScans overview={overview} scan={scan} />
          <ContentStudioCard overview={overview} />
        </div>
      </div>
    </div>
  );
}
