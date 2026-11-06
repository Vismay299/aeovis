import {
  initialScanProgress,
  beginScanProgress,
  applyScanReading,
  applyScanUnknown,
  isReconnecting,
} from "../../lib/scanProgress.js";

export const ACTIVE_SCAN_STATUSES = [
  "pending",
  "generating_prompts",
  "probing",
  "scoring",
];

export const PANEL_NOT_APPROVED = "panel_not_approved";
export const SCAN_ALREADY_RUNNING = "scan_already_running";

export const SCAN_STAGES = [
  { status: "pending", label: "Queued", detail: "Your scan is lined up to start" },
  {
    status: "generating_prompts",
    label: "Writing questions",
    detail: "Real buyer questions for your category",
  },
  {
    status: "probing",
    label: "Asking AI engines",
    detail: "Every question goes to each engine",
  },
  {
    status: "scoring",
    label: "Scoring answers",
    detail: "Which brands each answer names",
  },
];

export function scanStageIndex(status) {
  if (status === "complete") return SCAN_STAGES.length;
  return SCAN_STAGES.findIndex((stage) => stage.status === status);
}

export const SCAN_POLL_SECONDS = 2.5;
export const SCAN_STALL_MS = 3 * 60 * 1000;

export function initialTrackerState(brandKey) {
  return {
    brandKey,
    job: null,
    progress: initialScanProgress(),
    quietMs: null,
    finished: null,
    starting: false,
    error: "",
    errorCode: null,
    notice: "",
    settledJobIds: [],
    notifySeq: 0,
  };
}

export function scanTrackerReducer(state, action) {
  switch (action.type) {
    case "brandChanged": {
      if (state.brandKey === action.brandKey && state.job === null && state.settledJobIds.length === 0) {
        return state;
      }
      return initialTrackerState(action.brandKey);
    }

    case "jobsSeen": {
      if (state.job && ACTIVE_SCAN_STATUSES.includes(state.job.status)) {
        return state;
      }
      const candidate = (action.jobs || []).find(
        (c) =>
          ACTIVE_SCAN_STATUSES.includes(c.status) &&
          !state.settledJobIds.includes(c.id)
      );
      if (!candidate) return state;
      return {
        ...state,
        job: {
          id: candidate.id,
          status: candidate.status,
          created_at: candidate.created_at,
        },
        finished: null,
        quietMs: null,
        progress: applyScanReading(beginScanProgress(), {
          stage: Math.max(0, scanStageIndex(candidate.status)),
          progressPct: candidate.progress_pct,
        }),
      };
    }

    case "statusReceived": {
      if (!state.job || action.jobId !== state.job.id) {
        return state;
      }

      if (action.httpStatus === 404) {
        return {
          ...state,
          settledJobIds: [...state.settledJobIds, action.jobId],
          job: null,
          progress: initialScanProgress(),
          quietMs: null,
        };
      }

      if (
        !action.ok ||
        !action.body ||
        action.body.transient_error ||
        action.body.status === "unknown"
      ) {
        const reason =
          action.body?.status === "unknown"
            ? "transient_error"
            : `http_${action.httpStatus}`;
        return {
          ...state,
          progress: applyScanUnknown(state.progress, { reason }),
        };
      }

      const body = action.body;
      const quietMs =
        typeof body.execution?.quiet_ms === "number"
          ? body.execution.quiet_ms
          : null;

      if (body.status === "complete") {
        return {
          ...state,
          settledJobIds: [...state.settledJobIds, action.jobId],
          job: state.job ? { ...state.job, status: "complete" } : state.job,
          progress: applyScanReading(state.progress, {
            stage: SCAN_STAGES.length,
            progressPct: 100,
          }),
          finished: {
            status: "complete",
            jobId: action.jobId,
            resultId: body.result_id || null,
            terminal_outcome: body.terminal_outcome,
            at: Date.now(),
          },
          notifySeq: state.notifySeq + 1,
          quietMs,
        };
      }

      if (body.status === "failed") {
        return {
          ...state,
          settledJobIds: [...state.settledJobIds, action.jobId],
          job: state.job ? { ...state.job, status: "failed" } : state.job,
          finished: {
            status: "failed",
            jobId: action.jobId,
            error: body.error_message || null,
            at: Date.now(),
          },
          notifySeq: state.notifySeq + 1,
          quietMs,
        };
      }

      return {
        ...state,
        job: state.job
          ? {
              ...state.job,
              status: body.status,
              created_at: state.job.created_at || body.created_at,
            }
          : state.job,
        progress: applyScanReading(state.progress, {
          stage: Math.max(0, scanStageIndex(body.status)),
          progressPct: body.progress_pct,
        }),
        quietMs,
      };
    }

    case "statusNetworkError": {
      if (!state.job || action.jobId !== state.job.id) {
        return state;
      }
      return {
        ...state,
        progress: applyScanUnknown(state.progress, { reason: "network" }),
      };
    }

    case "startRequested": {
      return {
        ...state,
        starting: true,
        error: "",
        errorCode: null,
        notice: "",
        finished: null,
      };
    }

    case "startResolved": {
      if (action.brandKey !== state.brandKey) {
        return state;
      }

      const outcome = action.outcome || {};
      if (outcome.kind === "started") {
        return {
          ...state,
          starting: false,
          job: {
            id: outcome.job_id,
            status: "pending",
            created_at: outcome.created_at || new Date().toISOString(),
          },
          progress: beginScanProgress(),
          quietMs: null,
          notifySeq: state.notifySeq + 1,
        };
      }

      if (outcome.kind === "panelNotApproved") {
        return {
          ...state,
          starting: false,
          errorCode: PANEL_NOT_APPROVED,
          error:
            "Scans ask the questions in your approved question panel. Review and approve it on Questions & evidence, then run the scan.",
        };
      }

      if (outcome.kind === "alreadyRunning") {
        return {
          ...state,
          starting: false,
          notice:
            "A scan is already running for this workspace — showing its progress.",
          notifySeq: state.notifySeq + 1,
        };
      }

      if (outcome.kind === "unauthorized") {
        return {
          ...state,
          starting: false,
        };
      }

      if (outcome.kind === "error") {
        return {
          ...state,
          starting: false,
          error: outcome.message || "Could not start the scan.",
        };
      }

      return {
        ...state,
        starting: false,
      };
    }

    case "dismissed": {
      const job =
        state.job && !ACTIVE_SCAN_STATUSES.includes(state.job.status)
          ? null
          : state.job;
      const progress = job === null ? initialScanProgress() : state.progress;
      return {
        ...state,
        finished: null,
        notice: "",
        error: "",
        errorCode: null,
        job,
        progress,
      };
    }

    default:
      return state;
  }
}

export function trackerView(state) {
  const jobActive = Boolean(
    state.job && ACTIVE_SCAN_STATUSES.includes(state.job.status)
  );
  const stageIndex = state.job ? Math.max(0, scanStageIndex(state.job.status)) : -1;
  return {
    job: state.job,
    active: jobActive,
    percent: typeof state.progress?.progress === "number" ? state.progress.progress : null,
    stageIndex,
    stage:
      stageIndex >= 0 && stageIndex < SCAN_STAGES.length
        ? SCAN_STAGES[stageIndex]
        : null,
    reconnecting: isReconnecting(state.progress),
    stalled: typeof state.quietMs === "number" && state.quietMs > SCAN_STALL_MS,
    finished: state.finished,
    starting: state.starting,
    error: state.error,
    errorCode: state.errorCode,
    notice: state.notice,
  };
}
