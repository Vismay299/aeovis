"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, FolderOpen, Bot, Search } from "lucide-react";
import { fetchScanHistory, saveScan } from "@/services/api";

function scoreColor(v) {
  if (v == null) return "var(--text-3)";
  if (v >= 60) return "var(--good)";
  if (v >= 35) return "var(--warn)";
  return "var(--crit)";
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

const statusLabel = {
  awaiting_approval: "awaiting you",
  approved: "approved",
  rejected: "rejected",
  changes_requested: "in revision",
  draft: "draft",
};

/**
 * Case files shelf — previous runs as one slim row above the landing page.
 * Renders nothing until there's history, so first-time visitors see the
 * pure landing page. Deliberately compact: the poster stays the star.
 */
export function HomeDashboard() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      /* homepage history is best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any agent job is running so the shelf stays live.
  const hasActive = (data?.activeJobs || []).length > 0;
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [hasActive, load]);

  const openBrand = async (brand, view) => {
    setOpening(brand + (view || ""));
    try {
      const scans = await fetchScanHistory(brand);
      if (scans && scans[0]) saveScan(scans[0]);
      router.push(view ? `/dashboard?view=${view}` : "/dashboard");
    } catch {
      router.push("/dashboard");
    }
  };

  const openRun = async (run) => {
    setOpening(run.id);
    try {
      const scans = await fetchScanHistory(run.brand);
      if (scans && scans[0]) saveScan(scans[0]);
      router.push(`/dashboard?view=studio&item=${run.id}`);
    } catch {
      router.push("/dashboard?view=studio");
    }
  };

  if (loading) return null;

  const scans = data?.scans || [];
  const runs = data?.runs || [];
  const activeJobs = data?.activeJobs || [];
  const counts = data?.counts || {};

  // Nothing to show → let the landing page speak for itself.
  if (scans.length === 0 && runs.length === 0) return null;

  return (
    <section data-testid="home-dashboard" className="shelf">
      <div className="lp-container shelf-inner">
        <span className="shelf-label">
          <FolderOpen size={13} />
          your case files
        </span>

        <div className="shelf-files">
          {scans.map((s) => (
            <button
              key={s.brand}
              data-testid="home-brand-card"
              className="shelf-file"
              onClick={() => openBrand(s.brand)}
            >
              <span className="shelf-file-name">{s.brand}</span>
              <span className="shelf-file-score" style={{ color: scoreColor(s.score) }}>
                {s.score == null ? "—" : s.score}
              </span>
              <span className="shelf-file-meta">
                {timeAgo(s.scanned_at)} ago
                {opening === s.brand && (
                  <Loader2
                    size={10}
                    style={{
                      marginLeft: "6px",
                      display: "inline",
                      verticalAlign: "-1px",
                      animation: "spin 1s linear infinite",
                    }}
                  />
                )}
              </span>
            </button>
          ))}

          {runs.slice(0, 4).map((r) => (
            <button
              key={r.id}
              data-testid="home-run-card"
              className="shelf-file"
              onClick={() => openRun(r)}
              title={`${r.agent_name} · ${r.brand}`}
            >
              <span style={{ fontSize: "13px", flexShrink: 0 }}>{r.agent_emoji}</span>
              <span className="shelf-file-name">{r.title || "(untitled)"}</span>
              <span className="shelf-file-meta">{statusLabel[r.status] || "draft"}</span>
            </button>
          ))}
        </div>

        {activeJobs.length > 0 && (
          <span className="shelf-jobs">
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
            {activeJobs.length} agent{activeJobs.length === 1 ? "" : "s"} working
          </span>
        )}

        <div className="shelf-actions">
          {counts.awaiting > 0 && (
            <button
              className="shelf-btn is-ghost"
              onClick={() => scans[0] && openBrand(scans[0].brand, "studio")}
            >
              {counts.awaiting} awaiting you
            </button>
          )}
          {scans[0] && (
            <button
              className="shelf-btn is-primary"
              onClick={() => openBrand(scans[0].brand, "studio")}
            >
              <Bot size={13} /> Open Studio
            </button>
          )}
          <a href="#begin" className="shelf-btn is-ghost">
            <Search size={13} /> New scan
          </a>
        </div>
      </div>
    </section>
  );
}
