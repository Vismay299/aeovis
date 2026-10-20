"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import DashboardShell from "./DashboardShell";
import { reportResponseState, offlineReportState } from "@/lib/reportViewState";
export default function StoredReportPage({ url, scanId = null }) {
  const [resource, setResource] = useState({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const id = ++generation.current;
    const controller = new AbortController();
    setResource({ state: "loading" });
    if (!url) {
      setResource({
        state: "unavailable",
        message: "This report is unavailable.",
      });
      return () => controller.abort();
    }
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (generation.current === id && !controller.signal.aborted)
          setResource(reportResponseState(response.status, body));
      })
      .catch((error) => {
        if (error.name !== "AbortError" && generation.current === id)
          setResource(offlineReportState());
      });
    return () => controller.abort();
  }, [url, attempt]);
  if (resource.state === "loading")
    return (
      <div role="status" aria-live="polite" className="pv-empty">
        <p>Loading report…</p>
      </div>
    );
  if (resource.scan) {
    const outcome =
      resource.scan.summary_stats?.terminal_outcome ||
      resource.scan.raw_results?.summary_stats?.terminal_outcome;
    const download = () => {
      const href = URL.createObjectURL(
        new Blob([JSON.stringify(resource.scan, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = href;
      link.download = `measurement-${resource.scan.id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    };
    return (
      <>
        {outcome && (
          <section
            role="status"
            aria-label="Collection outcome"
            style={{ padding: 16 }}
          >
            <strong>Collection: {outcome.outcome}</strong>
            <p>
              {outcome.counts?.planned} planned · {outcome.counts?.answered}{" "}
              answered · {outcome.counts?.valid_no_aio} valid without AIO ·{" "}
              {outcome.counts?.failed} failed · {outcome.counts?.not_attempted}{" "}
              not attempted.
            </p>
            {outcome.outcome !== "complete" && (
              <p>
                Review failed surfaces and provider readiness before retrying.
                Missing observations are not measured non-mentions.
              </p>
            )}
            <button onClick={download}>Download measurement JSON</button>
          </section>
        )}
        <DashboardShell
          scan={resource.scan}
          scanId={scanId || resource.scan.id}
        />
      </>
    );
  }
  return (
    <main className="pv-main">
      <section
        role="alert"
        aria-live="polite"
        className="pv-card"
        style={{ padding: 32, maxWidth: 720, margin: "40px auto" }}
      >
        <h1>
          Report{" "}
          {resource.state === "authentication_required"
            ? "access"
            : "unavailable"}
        </h1>
        <p>{resource.message}</p>
        {resource.retryable && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry report
          </button>
        )}
        {resource.state === "authentication_required" && (
          <a
            href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/portal" : window.location.pathname)}`}
          >
            Sign in
          </a>
        )}
        <Link href="/portal/scans" style={{ marginLeft: 16 }}>
          Workspace history
        </Link>
      </section>
    </main>
  );
}
