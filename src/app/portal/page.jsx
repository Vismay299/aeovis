"use client";

import { Play, PenLine } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { ScanProgressCard } from "@/components/portal/ScanProgressCard";
import { Button, PageHeader } from "@/components/portal/ui";
import { QueryError } from "@/components/app/QueryState";
import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import { SetupChecklist } from "@/components/portal/overview/SetupChecklist";
import KpiRow from "@/components/portal/overview/KpiRow";
import VisibilityTrend from "@/components/portal/overview/VisibilityTrend";
import RecentScans from "@/components/portal/overview/RecentScans";
import ContentStudioCard from "@/components/portal/overview/ContentStudioCard";
import { websiteHost } from "@/components/portal/overview/overviewModel";
import { NextRunBadge } from "@/components/portal/schedule/NextRunBadge";

export default function OverviewPage() {
  const {
    brand,
    overview,
    overviewError,
    overviewQueryError,
    refreshOverview,
    gsc,
    scan,
  } = usePortal();
  const workspace = useWorkspace();
  const onboardingWizard = workspace?.features?.onboarding_wizard === true;

  const name = brand?.display_name || overview?.brand?.display_name || "Your brand";
  const host = websiteHost(brand?.website || overview?.brand?.website);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={host || undefined}
        title={name}
        description="How AI answer engines talk about your brand."
        actions={
          <>
            <NextRunBadge />
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
          <QueryError
            error={overviewQueryError}
            fallback={overviewError}
            title="Overview could not load"
            onRetry={refreshOverview}
            variant="card"
          />
        ) : null}

        <ScanProgressCard showIdle={!overview?.scans?.length} />

        {onboardingWizard ? <SetupChecklist /> : null}

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
