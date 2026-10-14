"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Play, Radar } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { ScanProgressCard } from "@/components/portal/ScanProgressCard";
import MockScanPanel from "@/components/portal/scans/MockScanPanel";
import {
  Badge, Banner, Button, Card, EmptyState, PageHeader, ProgressBar, SkeletonRows,
  formatDate, formatPct,
} from "@/components/portal/ui";
import { platformLabel } from "@/components/portal/scans/reportData";
import "@/components/portal/scans/scans.css";

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ScanRow({ scan, onOpen }) {
  const visibility = finiteOrNull(scan.visibility_pct);
  const tracked = finiteOrNull(scan.prompts_tracked);
  const mentioned = finiteOrNull(scan.prompts_mentioned);
  const label = `Open scan from ${formatDate(scan.scanned_at || scan.created_at, { withTime: true })}`;

  return (
    <tr
      className="is-link"
      tabIndex={0}
      aria-label={label}
      onClick={() => onOpen(scan.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(scan.id);
        }
      }}
    >
      <td className="pv-scans-date">{formatDate(scan.scanned_at || scan.created_at, { withTime: true })}</td>
      <td>
        <div className="pv-scans-vis">
          <span className="pv-scans-vis__bar">
            <ProgressBar value={visibility} indeterminate={false} size="sm" label="AI visibility" />
          </span>
          <span className={`pv-scans-vis__value${visibility === null ? " is-empty" : ""}`}>
            {formatPct(visibility)}
          </span>
        </div>
        {scan.collection_partial ? <Badge tone="warn">Partial collection</Badge> : null}
      </td>
      <td className="is-num">{tracked === null ? "—" : tracked}</td>
      <td className="is-num">
        {mentioned === null || tracked === null ? "—" : `${mentioned} of ${tracked}`}
      </td>
      <td className="pv-scans-engines">{platformLabel(scan.platform)}</td>
      <td className="pv-scans-chevron" aria-hidden="true"><ChevronRight /></td>
    </tr>
  );
}

export default function ScansPage() {
  const router = useRouter();
  const { brandKey, brand, scan, redirectToLogin } = usePortal();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  // A different workspace must not show the previous workspace's history.
  useEffect(() => {
    setData(null);
  }, [brandKey]);

  useEffect(() => {
    if (!brandKey) return undefined;
    let live = true;
    setLoading(true);
    setError("");
    fetch(`/api/customer/scan?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) { redirectToLogin(); return; }
        const body = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok) {
          setError(body?.error || "Could not load scans.");
          return;
        }
        setData(body);
      })
      .catch(() => {
        if (live) setError("Could not load scans. Check your connection and try again.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, [brandKey, redirectToLogin, scan.finished, reloadToken]);

  const scans = useMemo(() => (Array.isArray(data?.scans) ? data.scans : []), [data]);
  const failedRuns = useMemo(() => {
    const cutoff = Date.now() - FAILED_WINDOW_MS;
    return (Array.isArray(data?.jobs) ? data.jobs : []).filter((job) => {
      if (job?.status !== "failed") return false;
      const at = new Date(job.created_at).getTime();
      return Number.isFinite(at) && at >= cutoff;
    });
  }, [data]);

  const openScan = (id) => router.push(`/portal/scans/${encodeURIComponent(id)}`);
  const initialLoad = loading && !data;
  const showEmpty = !initialLoad && !error && scans.length === 0 && !scan.active;

  return (
    <div className="pv-page">
      <PageHeader
        title="Scans"
        description="Every AI visibility scan for this workspace."
        actions={(
          <Button
            icon={Play}
            loading={scan.starting}
            disabled={scan.active || !brandKey}
            onClick={() => scan.start()}
          >
            Run scan
          </Button>
        )}
      />

      <div className="pv-stack">
        <ScanProgressCard showIdle={false} />
        {brandKey ? <MockScanPanel key={brandKey} brandKey={brandKey} brandName={brand?.display_name || "this workspace"} onUnauthorized={redirectToLogin} /> : null}

        {error ? (
          <Banner
            tone="error"
            title="Scans did not load"
            action={<Button variant="secondary" size="sm" onClick={() => setReloadToken((n) => n + 1)}>Retry</Button>}
          >
            {error}
          </Banner>
        ) : null}

        {initialLoad ? (
          <Card title="Scan history" flush>
            <SkeletonRows rows={4} />
          </Card>
        ) : showEmpty ? (
          <Card>
            <EmptyState
              icon={Radar}
              title="No scans yet"
              action={<Button icon={Play} loading={scan.starting} disabled={scan.active || !brandKey} onClick={() => scan.start()}>Run scan</Button>}
            >
              Run your first scan to see which brands AI engines recommend for your category.
            </EmptyState>
          </Card>
        ) : scans.length > 0 ? (
          <Card
            title="Scan history"
            description={brand?.display_name ? `Each scan of ${brand.display_name}, newest first.` : "Newest first."}
            flush
          >
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Visibility</th>
                    <th scope="col" className="is-num">Questions</th>
                    <th scope="col" className="is-num">Mentioned</th>
                    <th scope="col">Engines</th>
                    <th scope="col"><span className="pv-scans-sr">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {scans.map((row) => (
                    <ScanRow key={row.id} scan={row} onOpen={openScan} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {failedRuns.length > 0 ? (
          <Card
            title="Failed runs"
            description="Runs from the last 7 days that stopped before finishing."
            flush
          >
            <div className="pv-scans-failed">
              {failedRuns.map((job) => (
                <div key={job.id} className="pv-scans-failed__row">
                  <div style={{ minWidth: 0 }}>
                    <div className="pv-scans-failed__date">{formatDate(job.created_at, { withTime: true })}</div>
                    <p className="pv-scans-failed__msg">
                      {job.error_message || "The scan stopped before finishing."}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" disabled={scan.active || !brandKey} loading={scan.starting} onClick={() => scan.start()}>
                    Retry
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
