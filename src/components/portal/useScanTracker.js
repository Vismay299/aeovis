"use client";

/**
 * Tracks the workspace's running AI visibility scan for the customer portal.
 *
 * It polls GET /api/scan/<job_id>/status — the same route the public scan page
 * polls. That route is not just a read: every poll also checks the run ledger
 * and re-fires a stalled scan chunk (poll-driven rescue, P0.2). Without this
 * poll a customer scan only advanced when the 10-minute cron sweep reached it,
 * which is why the portal used to sit on "generating_prompts · 10%".
 *
 * Progress is folded through lib/scanProgress so a blip never rewinds the bar
 * and "unknown" is never drawn as 0%.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  initialScanProgress,
  beginScanProgress,
  applyScanReading,
  applyScanUnknown,
  isReconnecting,
} from "@/lib/scanProgress";

export const ACTIVE_SCAN_STATUSES = ["pending", "generating_prompts", "probing", "scoring"];

export const SCAN_STAGES = [
  { status: "pending", label: "Queued", detail: "Your scan is lined up to start" },
  { status: "generating_prompts", label: "Writing questions", detail: "Real buyer questions for your category" },
  { status: "probing", label: "Asking AI engines", detail: "Every question goes to each engine" },
  { status: "scoring", label: "Scoring answers", detail: "Which brands each answer names" },
];

/** Index into SCAN_STAGES; SCAN_STAGES.length once complete, -1 if unknown. */
export function scanStageIndex(status) {
  if (status === "complete") return SCAN_STAGES.length;
  return SCAN_STAGES.findIndex((stage) => stage.status === status);
}

const POLL_MS = 2500;
/** Matches HEARTBEAT_STALE_MS: past this the status route rescues the run. */
export const SCAN_STALL_MS = 3 * 60 * 1000;

export function useScanTracker({ brandKey, jobs, onFinished, onUnauthorized }) {
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(initialScanProgress);
  const [quietMs, setQuietMs] = useState(null);
  const [finished, setFinished] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Overview can lag behind a status poll. Never resurrect a scan that has
  // already finished or returned 404 during this workspace session.
  const settledJobIds = useRef(new Set());

  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  // A different workspace is a different scan.
  useEffect(() => {
    settledJobIds.current = new Set();
    setJob(null);
    setProgress(initialScanProgress());
    setQuietMs(null);
    setFinished(null);
    setError("");
    setNotice("");
  }, [brandKey]);

  // Adopt a scan that is already running (started in another tab, by a
  // teammate, or before a reload) as soon as the overview reports it.
  useEffect(() => {
    if (job && ACTIVE_SCAN_STATUSES.includes(job.status)) return;
    const running = (jobs || []).find((candidate) =>
      ACTIVE_SCAN_STATUSES.includes(candidate.status) && !settledJobIds.current.has(candidate.id),
    );
    if (!running) return;
    setJob({ id: running.id, status: running.status, created_at: running.created_at });
    setFinished(null);
    setQuietMs(null);
    setProgress(
      applyScanReading(beginScanProgress(), {
        stage: Math.max(0, scanStageIndex(running.status)),
        progressPct: running.progress_pct,
      }),
    );
  }, [jobs, job]);

  const jobId = job?.id || null;
  const jobActive = Boolean(job && ACTIVE_SCAN_STATUSES.includes(job.status));

  useEffect(() => {
    if (!jobId || !jobActive) return undefined;
    let live = true;
    let timer = null;

    async function poll() {
      try {
        const response = await fetch(`/api/scan/${encodeURIComponent(jobId)}/status`, { cache: "no-store" });
        if (!live) return;
        if (response.status === 404) {
          // Gone, or not this account's: stop tracking rather than spin forever.
          settledJobIds.current.add(jobId);
          setJob(null);
          setProgress(initialScanProgress());
          setQuietMs(null);
          return;
        }
        const body = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok || !body || body.transient_error || body.status === "unknown") {
          setProgress((prev) => applyScanUnknown(prev, { reason: body?.status === "unknown" ? "transient_error" : `http_${response.status}` }));
        } else {
          setQuietMs(typeof body.execution?.quiet_ms === "number" ? body.execution.quiet_ms : null);
          if (body.status === "complete") {
            settledJobIds.current.add(jobId);
            setProgress((prev) => applyScanReading(prev, { stage: SCAN_STAGES.length, progressPct: 100 }));
            setJob((prev) => (prev ? { ...prev, status: "complete" } : prev));
            setFinished({ status: "complete", jobId, resultId: body.result_id || null, terminal_outcome: body.terminal_outcome, at: Date.now() });
            onFinishedRef.current?.();
            return;
          }
          if (body.status === "failed") {
            settledJobIds.current.add(jobId);
            setJob((prev) => (prev ? { ...prev, status: "failed" } : prev));
            setFinished({ status: "failed", jobId, error: body.error_message || null, at: Date.now() });
            onFinishedRef.current?.();
            return;
          }
          setJob((prev) => (prev ? { ...prev, status: body.status, created_at: prev.created_at || body.created_at } : prev));
          setProgress((prev) =>
            applyScanReading(prev, { stage: Math.max(0, scanStageIndex(body.status)), progressPct: body.progress_pct }),
          );
        }
      } catch {
        if (!live) return;
        setProgress((prev) => applyScanUnknown(prev, { reason: "network" }));
      }
      if (live) timer = setTimeout(poll, POLL_MS);
    }

    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, jobActive]);

  const start = useCallback(async () => {
    if (!brandKey || starting) return;
    setStarting(true);
    setError("");
    setNotice("");
    setFinished(null);
    try {
      const response = await fetch("/api/customer/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_key: brandKey }),
      });
      if (response.status === 401) {
        onUnauthorizedRef.current?.();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 409) {
        // Not an error: one is already running. Show its progress instead.
        setNotice("A scan is already running for this workspace — showing its progress.");
        onFinishedRef.current?.();
        return;
      }
      if (!response.ok) throw new Error(body.error || "Could not start the scan.");
      setJob({ id: body.job_id, status: "pending", created_at: new Date().toISOString() });
      setProgress(beginScanProgress());
      setQuietMs(null);
      onFinishedRef.current?.();
    } catch (startError) {
      setError(startError.message || "Could not start the scan.");
    } finally {
      setStarting(false);
    }
  }, [brandKey, starting]);

  const dismiss = useCallback(() => {
    setFinished(null);
    setNotice("");
    setError("");
    if (job && !ACTIVE_SCAN_STATUSES.includes(job.status)) {
      setJob(null);
      setProgress(initialScanProgress());
    }
  }, [job]);

  const stageIndex = job ? Math.max(0, scanStageIndex(job.status)) : -1;

  return {
    /** The tracked job ({ id, status, created_at }) or null. */
    job,
    /** True while a scan is queued or running. */
    active: jobActive,
    /** 0–100, or null when no percentage has been reported yet. */
    percent: typeof progress.progress === "number" ? progress.progress : null,
    stageIndex,
    stage: stageIndex >= 0 && stageIndex < SCAN_STAGES.length ? SCAN_STAGES[stageIndex] : null,
    reconnecting: isReconnecting(progress),
    /** True once nothing has moved for a full staleness window. */
    stalled: typeof quietMs === "number" && quietMs > SCAN_STALL_MS,
    /** { status: "complete" | "failed", jobId, error?, at } after a tracked run ends. */
    finished,
    starting,
    error,
    notice,
    start,
    dismiss,
  };
}
