/**
 * Scan progress state — "we do not know" is not "zero".
 *
 * R2.8.3 (finding A11). The status route answers a transient DB read failure
 * with `progress_pct: null`. The scan page fed that null straight into
 * `{progress}% complete` and into `scaleX(progress / 100)`, so one blip during
 * a ten-minute run wiped the label to "% complete" and rewound the bar to
 * empty. The user saw a scan restart that had not restarted.
 *
 * Everything the page needs to avoid that lives here as a pure reducer, so it
 * can be tested without a React renderer (this tree has none):
 *
 *   - A reading with no percentage NEVER becomes 0. The last known percentage
 *     is kept; if none was ever reported the value stays `null` and renders as
 *     an em dash plus a state chip, never as "0%".
 *   - Progress and stage are monotonic within a run. A late/out-of-order poll
 *     cannot rewind what the user has already seen. A new run starts from
 *     `beginScanProgress()`, which is the only way back to the start.
 *   - A poll that produced no reading at all (network blip, transient_error
 *     from the route, a status string the client does not know) is recorded as
 *     a connection state — `reconnecting` — with a reason. A skipped poll is
 *     visible, not silent.
 */

export const CONNECTION_LIVE = "live";
export const CONNECTION_RECONNECTING = "reconnecting";

/** Before a scan has been started: no stage, no measurement, nothing claimed. */
export function initialScanProgress() {
  return { stage: -1, progress: null, connection: CONNECTION_LIVE, unknownReason: null };
}

/** The moment a run is submitted: stage 0, and still no measured progress. */
export function beginScanProgress() {
  return { stage: 0, progress: null, connection: CONNECTION_LIVE, unknownReason: null };
}

function clampPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * Fold in a real reading from the status poll.
 *
 * `progressPct` may legitimately be `null`/`undefined` (the job row has not
 * recorded a percentage yet). That is unknown, not zero: the previous value
 * survives untouched.
 */
export function applyScanReading(prev, { stage, progressPct } = {}) {
  const base = prev || initialScanProgress();
  const pct = clampPct(progressPct);
  const nextStage =
    Number.isInteger(stage) && stage >= 0 ? Math.max(base.stage, stage) : base.stage;

  let nextProgress = base.progress;
  if (pct !== null) {
    nextProgress = base.progress === null ? pct : Math.max(base.progress, pct);
  }

  return {
    stage: nextStage,
    progress: nextProgress,
    connection: CONNECTION_LIVE,
    unknownReason: null,
  };
}

/**
 * Record a poll that yielded no reading. Progress and stage are left exactly
 * as they were — the user keeps what they had — and the connection state says
 * out loud that the last tick told us nothing.
 */
export function applyScanUnknown(prev, { reason } = {}) {
  const base = prev || initialScanProgress();
  return {
    ...base,
    connection: CONNECTION_RECONNECTING,
    unknownReason: reason || "unknown",
  };
}

/** True while the client is polling but not getting readings. */
export function isReconnecting(state) {
  return (state || {}).connection === CONNECTION_RECONNECTING;
}

/**
 * What the progress tag shows. `known: false` means the page must render the
 * em dash and a state chip — there is no number to round.
 */
export function progressLabel(state) {
  const base = state || initialScanProgress();
  const known = typeof base.progress === "number" && Number.isFinite(base.progress);
  return {
    known,
    text: known ? `${Math.round(base.progress)}% complete` : "—",
    chip: isReconnecting(base)
      ? "Reconnecting"
      : known
        ? null
        : "Progress not reported yet",
  };
}

/** Bar fill, 0..1. Unknown draws empty — but the label says so, and never "0%". */
export function progressFraction(state) {
  const base = state || initialScanProgress();
  if (typeof base.progress !== "number" || !Number.isFinite(base.progress)) return 0;
  return Math.min(1, Math.max(0, base.progress / 100));
}
