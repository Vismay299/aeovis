"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import {
  Banner, Button, Card, EmptyState, PageHeader, Skeleton, SkeletonRows, Stat, formatDate,
} from "@/components/portal/ui";
import { CompetitorsCard, EngineScoresCard, QuestionsCard } from "@/components/portal/scans/ReportCards";
import { engineLabel, finiteNumber, readCompetitors, readEngineScores, roundedPct } from "@/components/portal/scans/reportData";
import "@/components/portal/scans/scans.css";

function KpiSkeleton() {
  return (
    <div className="pv-card pv-stat" aria-hidden="true">
      <Skeleton width={96} height={11} />
      <Skeleton width={72} height={26} style={{ marginTop: 8 }} />
    </div>
  );
}

export default function ScanReportPage() {
  const params = useParams();
  const scanId = typeof params?.scanId === "string" ? params.scanId : "";
  const { redirectToLogin } = usePortal();

  const [state, setState] = useState({ status: "loading", report: null, error: "" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!scanId) {
      setState({ status: "notfound", report: null, error: "" });
      return undefined;
    }
    let live = true;
    setState((prev) => ({ status: "loading", report: prev.report && prev.report.scan?.id === scanId ? prev.report : null, error: "" }));
    fetch(`/api/customer/scan/report/${encodeURIComponent(scanId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) { redirectToLogin(); return; }
        if (response.status === 404) { setState({ status: "notfound", report: null, error: "" }); return; }
        const body = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok || !body?.scan) {
          setState({ status: "error", report: null, error: body?.error || "Could not load the scan report." });
          return;
        }
        setState({ status: "ready", report: body, error: "" });
      })
      .catch(() => {
        if (live) setState({ status: "error", report: null, error: "Could not load the scan report. Check your connection and try again." });
      });
    return () => { live = false; };
  }, [scanId, redirectToLogin, reloadToken]);

  const report = state.report;
  const scan = report?.scan || null;
  const results = useMemo(() => (Array.isArray(report?.results) ? report.results : []), [report]);

  const engineRows = useMemo(() => (scan ? readEngineScores(scan.engine_scores, scan.engines) : []), [scan]);
  const competitorRows = useMemo(
    () => (scan ? readCompetitors({ competitors: scan.competitors, engines: scan.engines, brand: scan.brand }).rows : []),
    [scan],
  );
  const showEngines = engineRows.length > 0;
  const showCompetitors = competitorRows.length > 0;

  const tracked = finiteNumber(scan?.prompts_tracked);
  const mentioned = finiteNumber(scan?.prompts_mentioned);

  if (state.status === "notfound") {
    return (
      <div className="pv-page">
        <div className="pv-scans-back">
          <Button variant="ghost" size="sm" href="/portal/scans" icon={ArrowLeft}>All scans</Button>
        </div>
        <PageHeader title="Scan report" />
        <Card>
          <EmptyState
            title="Scan not found"
            action={<Button variant="secondary" href="/portal/scans" icon={ArrowLeft}>Back to scans</Button>}
          >
            This scan does not exist, or it belongs to a workspace you cannot open.
          </EmptyState>
        </Card>
      </div>
    );
  }

  const loading = state.status === "loading" && !scan;

  return (
    <div className="pv-page">
      <div className="pv-scans-back">
        <Button variant="ghost" size="sm" href="/portal/scans" icon={ArrowLeft}>All scans</Button>
      </div>

      <PageHeader
        eyebrow={scan ? formatDate(scan.scanned_at || scan.created_at, { withTime: true }) : undefined}
        title="Scan report"
        description={scan?.url || undefined}
      />

      <div className="pv-stack">
        {state.status === "error" ? (
          <Banner
            tone="error"
            title="Report did not load"
            action={<Button variant="secondary" size="sm" onClick={() => setReloadToken((n) => n + 1)}>Retry</Button>}
          >
            {state.error}
          </Banner>
        ) : null}

        {scan && Object.values(scan.engines || {}).some((engine) => engine?.data_source_issue || engine?.insufficient_sample) ? (
          <Banner tone="warning" title="Some engines could not be measured">
            {Object.entries(scan.engines || {}).filter(([, engine]) => engine?.data_source_issue || engine?.insufficient_sample).map(([key]) => engineLabel(key)).join(", ")} did not produce enough reliable answers. The overall visibility score excludes engines with collection failures; run another scan once collection recovers.
          </Banner>
        ) : null}
        <div className="pv-grid pv-grid--4">
          {loading ? (
            <>
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
            </>
          ) : (
            <>
              <Stat label="AI visibility" value={roundedPct(scan?.visibility_pct)} suffix="%" />
              <Stat
                label="Answers naming you"
                value={mentioned}
                sub={tracked !== null ? `of ${tracked} questions` : undefined}
              />
              <Stat label="Share of voice" value={roundedPct(scan?.share_of_voice_pct)} suffix="%" />
              <Stat label="Citation share" value={roundedPct(scan?.brand_citation_share_pct)} suffix="%" />
            </>
          )}
        </div>

        {scan && (showEngines || showCompetitors) ? (
          <div className={showEngines && showCompetitors ? "pv-scans-split" : "pv-stack"}>
            {showEngines ? <EngineScoresCard engineScores={scan.engine_scores} engines={scan.engines} /> : null}
            {showCompetitors ? (
              <CompetitorsCard competitors={scan.competitors} engines={scan.engines} brand={scan.brand} />
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <Card title="Questions" flush>
            <SkeletonRows rows={5} />
          </Card>
        ) : scan ? (
          <QuestionsCard results={results} />
        ) : null}
      </div>
    </div>
  );
}
