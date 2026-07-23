"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowRight, Radar, PenSquare, Inbox, Bot, Search } from "lucide-react";
import { fetchScanHistory, saveScan } from "@/services/api";

const card = {
  background: "var(--bg-1)",
  border: "1px solid var(--border-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-5)",
  cursor: "pointer",
  transition: "border-color var(--dur-fast), transform var(--dur-fast)",
  textAlign: "left",
  width: "100%",
};

const mono = {
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--text-3)",
};

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
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const statusVariant = {
  awaiting_approval: { bg: "var(--accent-soft)", fg: "var(--accent-text)", label: "awaiting approval" },
  approved: { bg: "var(--good-bg)", fg: "var(--good)", label: "approved" },
  rejected: { bg: "var(--crit-bg)", fg: "var(--crit)", label: "rejected" },
  changes_requested: { bg: "var(--warn-bg)", fg: "var(--warn)", label: "in revision" },
  draft: { bg: "var(--bg-2)", fg: "var(--text-2)", label: "draft" },
};

/**
 * Homepage workspace — your previous runs at a glance. Renders nothing until
 * there's history, so first-time visitors still see the pure landing page.
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

  // Poll while any agent job is running so the workspace stays live.
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

  if (loading) {
    return (
      <div style={{ maxWidth: "1120px", margin: "0 auto", padding: "var(--space-8) var(--space-6) 0", display: "flex", justifyContent: "center" }}>
        <Loader2 size={20} style={{ color: "var(--text-3)", animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  const scans = data?.scans || [];
  const runs = data?.runs || [];
  const activeJobs = data?.activeJobs || [];
  const counts = data?.counts || {};

  // Nothing to show → let the landing page speak for itself.
  if (scans.length === 0 && runs.length === 0) return null;

  return (
    <section
      data-testid="home-dashboard"
      style={{
        background: "var(--bg-0)",
        borderBottom: "1px solid var(--border-1)",
        padding: "var(--space-8) var(--space-6)",
      }}
    >
      <div style={{ maxWidth: "1120px", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--space-4)", flexWrap: "wrap", marginBottom: "var(--space-6)" }}>
          <div>
            <div style={mono}>Your workspace</div>
            <h2 style={{ fontFamily: "var(--font-sans)", fontSize: "24px", fontWeight: 600, color: "var(--text-1)", marginTop: "var(--space-2)", letterSpacing: "-0.01em" }}>
              Pick up where you left off
            </h2>
          </div>
          <div style={{ display: "flex", gap: "var(--space-5)" }}>
            {[
              { n: counts.brands || 0, l: "brands" },
              { n: counts.runs || 0, l: "content runs" },
              { n: counts.awaiting || 0, l: "awaiting you" },
            ].map((s) => (
              <div key={s.l} style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-sans)", fontSize: "22px", fontWeight: 600, color: s.l === "awaiting you" && s.n > 0 ? "var(--accent-text)" : "var(--text-1)" }}>{s.n}</div>
                <div style={mono}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Active jobs strip */}
        {activeJobs.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", background: "var(--accent-soft)", border: "1px solid var(--accent-border)", borderRadius: "var(--radius-1)", padding: "var(--space-3) var(--space-4)", marginBottom: "var(--space-6)", flexWrap: "wrap" }}>
            <Loader2 size={14} style={{ color: "var(--accent)", animation: "spin 1s linear infinite" }} />
            <span style={{ fontSize: "12px", color: "var(--accent-text)", fontWeight: 600 }}>
              {activeJobs.length} {activeJobs.length === 1 ? "agent is" : "agents are"} working:
            </span>
            {activeJobs.map((j) => (
              <button key={j.id} onClick={() => openBrand(j.brand, "studio")} style={{ display: "inline-flex", alignItems: "center", gap: "4px", background: "var(--bg-0)", border: "1px solid var(--accent-border)", borderRadius: "var(--radius-round)", padding: "2px 10px", fontSize: "11px", color: "var(--text-1)", cursor: "pointer" }}>
                {j.agent_emoji} {j.agent_name} · {j.brand} {j.progress_pct}%
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", gap: "var(--space-8)", alignItems: "start" }} className="home-dash-grid">
          {/* Brands / scans */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "var(--space-3)" }}>
              <Radar size={13} style={{ color: "var(--accent)" }} />
              <span style={mono}>Brands you&apos;ve scanned</span>
            </div>
            {scans.length === 0 ? (
              <div style={{ ...card, cursor: "default", color: "var(--text-3)", fontSize: "13px" }}>No scans yet.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-3)" }}>
                {scans.map((s) => (
                  <button
                    key={s.brand}
                    data-testid="home-brand-card"
                    onClick={() => openBrand(s.brand)}
                    style={card}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-3)")}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-1)")}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-2)" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.brand}</div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)", marginTop: "2px" }}>{s.url || ""}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontFamily: "var(--font-sans)", fontSize: "20px", fontWeight: 600, color: scoreColor(s.score) }}>{s.score == null ? "—" : `${s.score}`}</div>
                        <div style={mono}>share</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "var(--space-3)" }}>
                      <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
                        {timeAgo(s.scanned_at)} · {s.scan_count} {s.scan_count === 1 ? "scan" : "scans"}
                      </span>
                      {opening === s.brand ? (
                        <Loader2 size={12} style={{ color: "var(--accent)", animation: "spin 1s linear infinite" }} />
                      ) : (
                        <ArrowRight size={12} style={{ color: "var(--text-3)" }} />
                      )}
                    </div>
                    {s.engines?.length > 0 && (
                      <div style={{ display: "flex", gap: "4px", marginTop: "var(--space-2)" }}>
                        {s.engines.map((e) => (
                          <span key={e} style={{ ...mono, fontSize: "8px", padding: "1px 5px", background: "var(--bg-2)", borderRadius: "var(--radius-1)", color: "var(--text-2)" }}>
                            {e === "aio" ? "AIO" : e === "chatgpt" ? "ChatGPT" : e === "perplexity" ? "PPLX" : e}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Content runs */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "var(--space-3)" }}>
              <PenSquare size={13} style={{ color: "var(--accent)" }} />
              <span style={mono}>Recent content runs</span>
            </div>
            {runs.length === 0 ? (
              <div style={{ ...card, cursor: "default", color: "var(--text-3)", fontSize: "13px" }}>
                No content runs yet. Open a brand and head to Studio → Opportunities to point an agent at a gap.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                {runs.map((r) => {
                  const sv = statusVariant[r.status] || statusVariant.draft;
                  return (
                    <button
                      key={r.id}
                      data-testid="home-run-card"
                      onClick={() => openRun(r)}
                      style={{ ...card, padding: "var(--space-4)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-3)")}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-1)")}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                        <span style={{ fontSize: "18px", flexShrink: 0 }}>{r.agent_emoji}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title || "(untitled)"}</div>
                          <div style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-3)", marginTop: "2px" }}>
                            {r.agent_name} · {r.brand} · {timeAgo(r.updated_at)}
                          </div>
                        </div>
                        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", padding: "2px 8px", borderRadius: "var(--radius-1)", background: sv.bg, color: sv.fg }}>
                          {sv.label}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-7)", flexWrap: "wrap" }}>
          {scans[0] && (
            <button
              onClick={() => openBrand(scans[0].brand, "studio")}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "var(--accent)", color: "var(--accent-fg)", border: "none", borderRadius: "var(--radius-1)", padding: "10px 18px", fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", cursor: "pointer" }}
            >
              <Bot size={14} /> Open Studio
            </button>
          )}
          <a
            href="#begin"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "transparent", color: "var(--text-1)", border: "1px solid var(--border-3)", borderRadius: "var(--radius-1)", padding: "10px 18px", fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", cursor: "pointer", textDecoration: "none" }}
          >
            <Search size={14} /> Run a new scan
          </a>
        </div>
      </div>
    </section>
  );
}
