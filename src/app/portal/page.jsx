"use client";

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
import "@/components/portal/overview/overview.css";

export default function OverviewPage() {
  const { brand, overview, overviewError, refreshOverview, gsc, scan } = usePortal();

  const name = brand?.display_name || overview?.brand?.display_name || "Your brand";
  const host = websiteHost(brand?.website || overview?.brand?.website);
  const checklist = buildChecklist({ overview, gsc, scan });

  return (
    <div className="pv-page">
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

      <div className="pv-stack">
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

        <div className="pv-grid pv-overview-twocol">
          <RecentScans overview={overview} scan={scan} />
          <ContentStudioCard overview={overview} />
        </div>
      </div>
    </div>
  );
}
