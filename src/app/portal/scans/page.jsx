"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Play, Radar } from "lucide-react";
import { PrefetchLink } from "@/components/app/PrefetchLink";
import { scanReportQueryOptions } from "@/lib/query/portalQueries";
import { usePortal } from "@/components/portal/PortalShell";
import { ScanProgressCard } from "@/components/portal/ScanProgressCard";
import MockScanPanel from "@/components/portal/scans/MockScanPanel";
import {
  Badge, Banner, Button, Card, EmptyState, PageHeader, ProgressBar, SkeletonRows,
  formatDate, formatPct,
} from "@/components/portal/ui";
import { platformLabel, scanVisibilityState } from "@/components/portal/scans/reportData";
import { NextRunBadge } from "@/components/portal/schedule/NextRunBadge";
import "@/components/portal/scans/scans.css";

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ScanRow({ scan }) {
  const visibility = finiteOrNull(scan.visibility_pct);
  const tracked = finiteOrNull(scan.prompts_tracked);
  const mentioned = finiteOrNull(scan.prompts_mentioned);
  const pending = scanVisibilityState(scan) === "pending";
  const label = `Open scan from ${formatDate(scan.scanned_at || scan.created_at, { withTime: true })}`;

  return (
    <PrefetchLink
      href={`/portal/scans/${encodeURIComponent(scan.id)}`}
      prefetch={() => scanReportQueryOptions(scan.id)}
      aria-label={label}
      className="group flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
    >
      <div className="min-w-[140px] flex-1">
        <p className="text-sm font-medium text-foreground">
          {formatDate(scan.scanned_at || scan.created_at, { withTime: true })}
        </p>
        <p className="text-xs text-muted-foreground">{platformLabel(scan.platform)}</p>
      </div>

      <div className="flex items-center gap-3">
        <div className="w-24">
          <ProgressBar value={visibility} indeterminate={pending} size="sm" label="AI visibility" />
        </div>
        <span className={`w-12 text-right text-sm font-semibold tabular-nums ${visibility === null ? "text-muted-foreground" : "text-foreground"}`}>
          {formatPct(visibility)}
        </span>
        {scan.collection_partial ? <Badge tone="warn">Partial</Badge> : null}
      </div>

      <div className="hidden sm:block text-right text-xs text-muted-foreground tabular-nums">
        {tracked === null ? "—" : `${tracked} questions`}
        {mentioned !== null && tracked !== null ? ` · ${mentioned} mentioned` : ""}
      </div>

      <span className="reveal-on-hover text-muted-foreground" aria-hidden="true">
        <ChevronRight className="size-4" />
      </span>
    </PrefetchLink>
  );
}

export default function ScansPage() {
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

  const initialLoad = loading && !data;
  const showEmpty = !initialLoad && !error && scans.length === 0 && !scan.active;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scans"
        description="Every AI visibility scan for this workspace."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <NextRunBadge />
            <Button
              icon={Play}
              loading={scan.starting}
              disabled={scan.active || !brandKey}
              onClick={() => scan.start()}
            >
              Run scan
            </Button>
          </div>
        )}
      />

      <div className="space-y-6">
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
            <div className="divide-y divide-border">
              {scans.map((row) => (
                <ScanRow key={row.id} scan={row} />
              ))}
            </div>
          </Card>
        ) : null}

        {failedRuns.length > 0 ? (
          <Card
            title="Failed runs"
            description="Runs from the last 7 days that stopped before finishing."
            flush
          >
            <div className="divide-y divide-border">
              {failedRuns.map((job) => (
                <div key={job.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {formatDate(job.created_at, { withTime: true })}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {job.error?.message || "Scan stopped before finishing."}
                    </p>
                  </div>
                  <Badge tone="crit">Failed</Badge>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
