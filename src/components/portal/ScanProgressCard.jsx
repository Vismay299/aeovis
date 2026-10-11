"use client";

/**
 * The scan loading bar: live percentage, stage stepper, elapsed time, and the
 * honest states in between (no reading yet, reconnecting, taking longer than
 * usual). Reads the shell's single scan tracker, so the Overview and Scans
 * pages show the same run without polling twice.
 */

import { useEffect, useState } from "react";
import { Radar, Play } from "lucide-react";
import { usePortal } from "./PortalShell";
import { SCAN_STAGES } from "./useScanTracker";
import { Banner, Badge, Button, ProgressBar, StageSteps, formatDuration } from "./ui";

function useElapsed(since, running) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const start = since ? new Date(since).getTime() : NaN;
  return Number.isFinite(start) ? Math.max(0, now - start) : null;
}

/**
 * `showIdle` renders a call-to-action card when no scan is running; pages that
 * already have their own "Run scan" button pass false and get nothing.
 */
export function ScanProgressCard({ showIdle = true }) {
  const { scan, brand } = usePortal();
  const elapsed = useElapsed(scan.job?.created_at, scan.active);

  if (scan.finished?.status === "complete") {
    return (
      <Banner
        tone="success"
        title="Scan complete"
        onDismiss={scan.dismiss}
        action={scan.finished.resultId ? <Button size="sm" variant="secondary" href={`/portal/scans/${encodeURIComponent(scan.finished.resultId)}`}>View report</Button> : null}
      >
        Your latest AI visibility results are ready below.
      </Banner>
    );
  }

  if (scan.finished?.status === "failed") {
    return (
      <Banner tone="error" title="The scan did not finish" onDismiss={scan.dismiss} action={<Button size="sm" variant="secondary" onClick={scan.start} loading={scan.starting}>Try again</Button>}>
        {scan.finished.error || "Something went wrong while the engines were being asked. Starting a new scan usually fixes it."}
      </Banner>
    );
  }

  if (!scan.active) {
    if (!showIdle) {
      return scan.error ? <Banner tone="error" onDismiss={scan.dismiss}>{scan.error}</Banner> : null;
    }
    return (
      <section className="pv-card">
        <div className="pv-card__body" style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", paddingTop: 20 }}>
          <div className="pv-empty__icon" style={{ margin: 0 }}><Radar aria-hidden="true" /></div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <h2 className="pv-card__title">Check how AI engines see {brand?.display_name || "your brand"}</h2>
            <p className="pv-card__desc">We ask the answer engines real buyer questions and record which brands they recommend. Takes a few minutes.</p>
          </div>
          <Button icon={Play} onClick={scan.start} loading={scan.starting}>{scan.starting ? "Starting…" : "Run AI visibility scan"}</Button>
        </div>
        {scan.error ? <div style={{ padding: "0 20px 20px" }}><Banner tone="error">{scan.error}</Banner></div> : null}
      </section>
    );
  }

  const percent = scan.percent;
  const stageLabel = scan.stage?.label || "Starting";

  return (
    <section className="pv-card" aria-live="polite" data-testid="portal-scan-progress">
      <div className="pv-card__header">
        <div>
          <div className="pv-row" style={{ marginBottom: 4 }}>
            <Badge tone="brand" live>Scan running</Badge>
            {scan.reconnecting ? <Badge tone="warn" dot>Reconnecting…</Badge> : null}
          </div>
          <h2 className="pv-card__title">{stageLabel}…</h2>
          <p className="pv-card__desc">{scan.stage?.detail || "Getting your scan ready"}</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pv-stat__value pv-num" style={{ fontSize: 28 }}>
            {percent === null ? "—" : `${Math.round(percent)}%`}
          </div>
          <div className="pv-stat__sub">{elapsed === null ? "" : `${formatDuration(elapsed)} elapsed`}</div>
        </div>
      </div>
      <div className="pv-card__body" style={{ display: "grid", gap: 18 }}>
        <ProgressBar value={percent} active size="lg" label="Scan progress" />
        <StageSteps steps={SCAN_STAGES} current={scan.stageIndex} />
        {scan.notice ? <Banner tone="info" onDismiss={scan.dismiss}>{scan.notice}</Banner> : null}
        {scan.stalled ? (
          <Banner tone="warn" title="Taking longer than usual">
            The scan paused between steps. It resumes automatically while this page is open — no need to start a new one.
          </Banner>
        ) : null}
      </div>
    </section>
  );
}

export default ScanProgressCard;
