"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pollIntervalMs } from "@/lib/query/polling";
import { keys } from "@/lib/query/keys";
import {
  ACTIVE_SCAN_STATUSES,
  PANEL_NOT_APPROVED,
  SCAN_ALREADY_RUNNING,
  SCAN_POLL_SECONDS,
  initialTrackerState,
  scanTrackerReducer,
  trackerView,
} from "./scanTrackerModel";

export const PRICE_CHANGED = "price_changed";

export {
  ACTIVE_SCAN_STATUSES,
  PANEL_NOT_APPROVED,
  SCAN_ALREADY_RUNNING,
  SCAN_STAGES,
  scanStageIndex,
  SCAN_STALL_MS,
} from "./scanTrackerModel";

export function useScanTracker({ brandKey, jobs, onFinished, onUnauthorized, priceReview = false }) {
  const [state, setState] = useState(() => initialTrackerState(brandKey));
  const [review, setReview] = useState({
    open: false,
    priceChanged: null,
    error: null,
  });
  const dispatch = useCallback(
    (action) => setState((s) => scanTrackerReducer(s, action)),
    []
  );

  const brandRef = useRef(brandKey);
  brandRef.current = brandKey;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    dispatch({ type: "brandChanged", brandKey });
  }, [brandKey, dispatch]);

  useEffect(() => {
    dispatch({ type: "jobsSeen", jobs: jobs || [] });
  }, [jobs, state.job, dispatch]);

  const jobId = state.job?.id || null;
  const active = Boolean(
    state.job && ACTIVE_SCAN_STATUSES.includes(state.job.status)
  );
  const activeRef = useRef(active);
  activeRef.current = active;

  const statusQuery = useQuery({
    queryKey: keys.scanStatus(brandKey || "none", jobId || "none"),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/scan/${encodeURIComponent(jobId)}/status`, {
        cache: "no-store",
        signal,
      });
      const body = await response.json().catch(() => null);
      return { jobId, httpStatus: response.status, ok: response.ok, body };
    },
    enabled: Boolean(brandKey && jobId && active),
    refetchInterval: () =>
      activeRef.current
        ? pollIntervalMs(
            {},
            {
              isActive: () => true,
              floorSeconds: SCAN_POLL_SECONDS,
              fallbackSeconds: SCAN_POLL_SECONDS,
            }
          )
        : false,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (statusQuery.dataUpdatedAt > 0 && statusQuery.data) {
      dispatch({ type: "statusReceived", ...statusQuery.data });
    }
  }, [statusQuery.dataUpdatedAt, dispatch]);

  useEffect(() => {
    if (statusQuery.errorUpdatedAt > 0 && jobId) {
      dispatch({ type: "statusNetworkError", jobId });
    }
  }, [statusQuery.errorUpdatedAt, jobId, dispatch]);

  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (state.notifySeq > 0) {
      onFinishedRef.current?.();
      forceUpdate((c) => c + 1);
    }
  }, [state.notifySeq]);

  const confirmStart = useCallback(
    async (maxUsd) => {
      const requestedFor = brandKey;
      dispatch({ type: "startRequested" });
      try {
        const bodyPayload = { brand_key: requestedFor };
        if (maxUsd !== undefined) {
          bodyPayload.maxUsd = maxUsd;
          bodyPayload.max_usd = maxUsd;
        }
        const response = await fetch("/api/customer/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload),
        });
        if (response.status === 401) {
          onUnauthorizedRef.current?.();
          return;
        }
        const body = await response.json().catch(() => ({}));
        if (brandRef.current !== requestedFor) return;

        if (response.status === 409 && body.code === PRICE_CHANGED) {
          setReview({
            open: true,
            priceChanged: {
              approvedMaxUsd: body.details?.approvedMaxUsd,
              quote: body.details?.quote,
            },
            error: null,
          });
          dispatch({
            type: "startResolved",
            brandKey: requestedFor,
            outcome: {
              kind: "error",
              message: body.error || "The price changed.",
            },
          });
          return;
        }

        if (response.status === 409 && body.code === PANEL_NOT_APPROVED) {
          setReview({ open: false, priceChanged: null, error: null });
          dispatch({
            type: "startResolved",
            brandKey: requestedFor,
            outcome: { kind: "panelNotApproved" },
          });
          return;
        }
        if (response.status === 409 && body.code === SCAN_ALREADY_RUNNING) {
          setReview({ open: false, priceChanged: null, error: null });
          dispatch({
            type: "startResolved",
            brandKey: requestedFor,
            outcome: { kind: "alreadyRunning" },
          });
          return;
        }
        if (!response.ok) {
          setReview((prev) => ({
            ...prev,
            error: body.error || "Could not start the scan.",
          }));
          dispatch({
            type: "startResolved",
            brandKey: requestedFor,
            outcome: {
              kind: "error",
              message: body.error || "Could not start the scan.",
            },
          });
          return;
        }
        setReview({ open: false, priceChanged: null, error: null });
        dispatch({
          type: "startResolved",
          brandKey: requestedFor,
          outcome: { kind: "started", job_id: body.job_id },
        });
      } catch (startError) {
        if (brandRef.current !== requestedFor) return;
        setReview((prev) => ({
          ...prev,
          error: startError.message || "Could not start the scan.",
        }));
        dispatch({
          type: "startResolved",
          brandKey: requestedFor,
          outcome: {
            kind: "error",
            message: startError.message || "Could not start the scan.",
          },
        });
      }
    },
    [brandKey, dispatch]
  );

  const cancelReview = useCallback(() => {
    setReview({ open: false, priceChanged: null, error: null });
  }, []);

  const start = useCallback(() => {
    if (!brandKey || state.starting) return;
    if (priceReview) {
      setReview({ open: true, priceChanged: null, error: null });
      return;
    }
    return confirmStart(undefined);
  }, [brandKey, state.starting, priceReview, confirmStart]);

  const dismiss = useCallback(() => {
    dispatch({ type: "dismissed" });
  }, [dispatch]);

  return {
    ...trackerView(state),
    start,
    confirmStart,
    cancelReview,
    review,
    dismiss,
    postStart: confirmStart,
  };
}
