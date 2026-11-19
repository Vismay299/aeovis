"use client";

/**
 * The scan loading bar: live percentage, stage stepper, elapsed time, and the
 * honest states in between (no reading yet, reconnecting, taking longer than
 * usual). Reads the shell's single scan tracker, so the Overview and Scans
 * pages show the same run without polling twice.
 */

import { useEffect, useState } from "react";
import { Radar, Play } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { DotGridPulse } from "@/components/app/motion/DotGridPulse";
import { RollingNumber } from "@/components/app/motion/RollingNumber";
import { TextShimmer } from "@/components/motion-primitives/text-shimmer";
import { usePortal } from "./PortalShell";
import { PANEL_NOT_APPROVED, SCAN_STAGES } from "./useScanTracker";
import { scanCompletionNotice } from "@/shared/scanCompletion";
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

/** A failed start. With no approved panel, point to where the panel is approved. */
function ScanStartError({ scan, dismissible }) {
  const needsPanel = scan.errorCode === PANEL_NOT_APPROVED;
  return (
    <Banner
      tone="error"
      title={needsPanel ? "Approve your question panel first" : undefined}
      onDismiss={dismissible ? scan.dismiss : undefined}
      action={needsPanel ? <Button size="sm" variant="secondary" href="/portal/measurement">Review questions</Button> : null}
    >
      {scan.error}
    </Banner>
  );
}

/**
 * `showIdle` renders a call-to-action card when no scan is running; pages that
 * already have their own "Run scan" button pass false and get nothing.
 */
export function ScanProgressCard({ showIdle = true }) {
  const { scan, brand } = usePortal();
  const elapsed = useElapsed(scan.job?.created_at, scan.active);
  // TextShimmer is a motion effect with no media-query path of its own, so the
  // stage label falls back to plain text rather than shimmering regardless.
  const reduceMotion = useReducedMotion();

  if (scan.finished?.status === "complete") {
    const completion = scanCompletionNotice(scan.finished);
    return (
      <Banner
        tone={completion.tone}
        title={completion.title}
        onDismiss={scan.dismiss}
        action={scan.finished.resultId ? <Button size="sm" variant="secondary" href={`/portal/scans/${encodeURIComponent(scan.finished.resultId)}`}>View report</Button> : null}
      >
        {completion.message}
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
      return scan.error ? <ScanStartError scan={scan} dismissible /> : null;
    }
    return (
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm pv-card">
        <div className="flex flex-wrap items-center gap-4 pv-card__body">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card shadow-sm text-muted-foreground pv-empty__icon">
            <Radar aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-[220px] flex-1">
            <h2 className="text-base font-semibold text-foreground pv-card__title">
              Check how AI engines see {brand?.display_name || "your brand"}
            </h2>
            <p className="text-sm text-muted-foreground pv-card__desc">
              We ask the answer engines real buyer questions and record which brands they recommend. Takes a few minutes.
            </p>
          </div>
          <Button icon={Play} onClick={scan.start} loading={scan.starting}>
            {scan.starting ? "Starting…" : "Run AI visibility scan"}
          </Button>
        </div>
        {scan.error ? <div className="mt-4"><ScanStartError scan={scan} /></div> : null}
      </section>
    );
  }

  const percent = scan.percent;
  const stageLabel = scan.stage?.label || "Starting";

  return (
    <section className="rounded-xl border border-border bg-card p-6 shadow-sm pv-card" aria-live="polite" data-testid="portal-scan-progress">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4 pv-card__header">
        <div>
          <div className="mb-1 flex items-center gap-2 pv-row">
            <Badge tone="brand" live>Scan running</Badge>
            {scan.reconnecting ? <Badge tone="warn" dot>Reconnecting…</Badge> : null}
          </div>
          <h2 className="text-lg font-semibold text-foreground pv-card__title">
            {reduceMotion
              ? `${stageLabel}…`
              : <TextShimmer duration={1.6}>{`${stageLabel}…`}</TextShimmer>}
          </h2>
          <p className="text-sm text-muted-foreground pv-card__desc">{scan.stage?.detail || "Getting your scan ready"}</p>
        </div>
        <div className="text-right">
          <div className="text-3xl font-semibold tabular-nums text-foreground pv-stat__value pv-num">
            {percent === null ? "—" : <RollingNumber>{`${Math.round(percent)}%`}</RollingNumber>}
          </div>
          <div className="text-xs text-muted-foreground pv-stat__sub">
            {elapsed === null ? "" : `${formatDuration(elapsed)} elapsed`}
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-4 pv-card__body">
        <ProgressBar value={percent} active indeterminate size="lg" label="Scan progress" />
        {/* The running visual: a dot grid pulsing out from the centre. Anime.js
            short-circuits it under reduced motion and leaves a static grid. */}
        <div className="pointer-events-none h-10 overflow-hidden rounded-lg border border-border bg-background px-3">
          <DotGridPulse columns={21} rows={3} className="opacity-60" />
        </div>
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
