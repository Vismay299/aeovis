"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, FlaskConical, Loader2, Download, ShieldAlert } from "lucide-react";
import { Sidebar } from "@/components/perceev/Sidebar";
import { ThemeToggle } from "@/components/perceev/ThemeToggle";
import { ScoreBand } from "@/components/dashboard/ScoreBand";
import { OverviewView } from "@/components/dashboard/OverviewView";
import { AnswersView } from "@/components/dashboard/AnswersView";
import { RivalsView } from "@/components/dashboard/RivalsView";
import { SourcesView } from "@/components/dashboard/SourcesView";
import { QueriesView } from "@/components/dashboard/QueriesView";
import { CrawlabilityView } from "@/components/dashboard/CrawlabilityView";
import { StudioView } from "@/components/studio/StudioView";
import {
  fetchScanHistory,
  normalizeResult,
  getHistoryNonBrandedCount,
} from "@/services/api";
import { scoreTier, formatTimestamp, relativeTime, hasTimestamp } from "@/utils/format";
import { getBrandAliases } from "@/lib/scoring/aliases";
import { resolveBrandKey } from "@/lib/scoring/brandKey";
import {
  AIO_ERROR_RATE_LIMIT_PCT,
  AIO_MIN_NON_BRANDED_COVERAGE,
} from "@/lib/scoring/aioConstants";

/**
 * R2.7.3 (finding C1) — two records match only when BOTH carry a real instant.
 *
 * `scanTimestamp` is now null when a record has no collection time, and
 * `new Date(null).getTime()` is 0, not NaN. Comparing raw getTime() values would
 * make every unstamped record collide at the epoch and light up an unrelated
 * history card as "active". Missing is never equal to missing.
 */
function sameInstant(a, b) {
  if (!hasTimestamp(a) || !hasTimestamp(b)) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

const RERUN_STAGES = [
  "Submitting brand for analysis",
  "Sourcing real buyer queries",
  "Probing the answer engines",
  "Scoring visibility & composing evidence",
];

const VIEW_TITLE = {
  overview: "Overview",
  answers: "Answers",
  rivals: "Rivals",
  sources: "Sources",
  queries: "Tracked queries",
  crawlability: "Crawlability",
  studio: "Studio",
};

/* Engines are configured per deployment, so every engine-facing label is
   derived from what the scan actually reported — never a fixed list. */
const ENGINE_LABEL = {
  aio: "AI Overview",
  google_ai_overview: "AI Overview",
  chatgpt: "ChatGPT",
  openai: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
};

function engineLabel(key) {
  return ENGINE_LABEL[key] || String(key || "").toUpperCase();
}

/**
 * DashboardShell.
 *
 * The whole product surface: one app shell with a real sidebar and an inner
 * view router, so the five reading views and Studio share the same chrome.
 *
 * Props:
 *   scan   — the raw scan record to display, in a three-state contract:
 *              undefined -> still loading (skeleton)
 *              null      -> nothing to show (empty state)
 *              object    -> a scan record (DB row shape or a sample record);
 *                           normalized internally via normalizeResult()
 *   scanId — optional, the concrete `scans.id` of the record being shown.
 *            Reserved for a future precise "view this exact scan" deep link.
 */
export default function DashboardShell({ scan, scanId, error = null }) {
  const router = useRouter();
  const [result, setResult] = useState(undefined);
  const [history, setHistory] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [rerunStage, setRerunStage] = useState(0);
  const [rerunProgress, setRerunProgress] = useState(0);
  const [view, setView] = useState("overview");
  const [studioBadge, setStudioBadge] = useState(0);
  const [studioNotice, setStudioNotice] = useState(null);
  const [studioInitialItem, setStudioInitialItem] = useState(null);

  // Deep-link support: /dashboard/[brand]?view=studio&item=<id> lands directly
  // on a run from the homepage workspace. Read once from the URL on mount.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get("view");
      const validViews = ["overview", "answers", "rivals", "sources", "queries", "crawlability", "studio"];
      if (v && validViews.includes(v)) setView(v);
      const item = params.get("item");
      if (item) setStudioInitialItem(item);
    } catch {
      /* no-op */
    }
  }, []);

  // `scan` is supplied by the route: undefined while loading, null when there
  // is nothing to show, or the raw record (DB row or sample) once available.
  useEffect(() => {
    const normalized = scan
      ? normalizeResult(scan, scan.brand, scan.website)
      : scan;
    setResult(normalized);
    if (normalized && normalized.brand && !normalized.isSample) {
      fetchScanHistory(normalized.brand).then((scans) => setHistory(scans || []));
    }
  }, [scan]);

  // Studio badge: count of items awaiting human approval for this brand.
  useEffect(() => {
    const brand = result?.brand;
    if (!brand || result?.isSample) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/content-items?brand=${encodeURIComponent(brand)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setStudioBadge(
            (data.items || []).filter((i) => i.status === "awaiting_approval").length
          );
        }
      } catch {
        /* badge is best-effort */
      }
    };
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [result?.brand, result?.isSample]);

  // AnswersView gap-row trigger: prefilled geo_article job — the AI's current
  // answer and citations ride along as input.
  const handleGenerateContent = async (row) => {
    try {
      const res = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand: result.brand,
          playbook: "geo_article",
          input: {
            type: "gap",
            query: row.prompt,
            engine: row.engine || "aio",
            gap_kind: row.visible ? "rank_not_cited" : "absent",
            answer_text: row.aioText || "",
            citations: (row.aioReferences || []).map((r) => ({ href: r.href, title: r.title || "" })),
            topic: row.topic || undefined,
            brand_profile: "healthcare-cxo",
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to start content job");
      setStudioNotice(null);
      setView("studio");
    } catch (e) {
      setStudioNotice(e.message);
      setView("studio");
    }
  };

  const { scoreTrend, previousScan, sortedHistory, deltaSamePromptSet } = useMemo(() => {
    let scoreTrend = null;
    let previousScan = null;
    let sortedHistory = [];
    let deltaSamePromptSet = true;
    if (!result || !history?.length) return { scoreTrend, previousScan, sortedHistory, deltaSamePromptSet };

    sortedHistory = [...history].sort(
      (a, b) => new Date(b.scanned_at) - new Date(a.scanned_at)
    );
    const idx = sortedHistory.findIndex((s) => sameInstant(s.scanned_at, result.scanTimestamp));
    let prev = null;

    if (idx !== -1 && idx + 1 < sortedHistory.length) {
      // Find the most recent previous scan with the same prompt_set_id
      for (let j = idx + 1; j < sortedHistory.length; j++) {
        const candidate = sortedHistory[j];
        const candidatePromptSetId = candidate.prompt_set_id || "";
        const currentPromptSetId = result.promptSetId || result.prompt_set_id || "";
        const candidateScoringMajor = (candidate.scoring_version || "").split("-")[0] || "";
        const currentScoringMajor = (result.scoringVersion || "").split("-")[0] || "";

        if (candidatePromptSetId && currentPromptSetId && candidatePromptSetId === currentPromptSetId) {
          prev = candidate;
          break;
        }
        // Same scoring major version — also acceptable
        if (candidateScoringMajor === currentScoringMajor && candidatePromptSetId === currentPromptSetId) {
          prev = candidate;
          break;
        }
      }

      // If no matching prompt set found, mark as new prompt set
      if (!prev) {
        prev = sortedHistory[idx + 1]; // fallback for display purposes
        deltaSamePromptSet = false;
      }
    } else if (idx === -1 && sortedHistory.length > 0) {
      prev = sortedHistory[0];
      deltaSamePromptSet = false;
    }

    if (prev && deltaSamePromptSet) {
      // Compare hero-to-hero: multi-engine scans display the visibility index,
      // so the delta must use the index on both sides — not the AIO-only value.
      const currentHero = result.isMultiEngine
        ? (result.visibilityIndexPct ?? result.visibilityScore)
        : result.visibilityScore;
      const prevHero =
        prev.raw_results?.visibility_index_pct ?? prev.visibility_pct ?? 0;
      scoreTrend = (currentHero - prevHero).toFixed(1);
    }
    if (prev) {
      previousScan = normalizeResult(prev, result.brand, result.website);
    }
    return { scoreTrend, previousScan, sortedHistory, deltaSamePromptSet };
  }, [result, history]);

  // ── error state ───────────────────────────────────────────────────
  //
  // R2.8.4 — kept ABOVE the empty state deliberately. A failed load must never
  // fall through to "Your dashboard is waiting": that tells a user with real
  // history that they have none, and invites them to spend a scan to fix a
  // problem that is ours. This state says what happened and offers a retry;
  // it does NOT offer to run a scan.
  if (error) {
    return (
      <div className="scan">
        <div className="scan__in">
          <div className="card" data-testid="dashboard-error" style={{ padding: "clamp(28px,4vw,48px)" }}>
            <span className="tag">Couldn't load</span>
            <h2 style={{ margin: "16px 0 14px", fontSize: "clamp(26px,3vw,38px)" }}>
              We couldn't reach your data
            </h2>
            <p className="scan__sub">
              {error} This is a problem on our side, not a missing report — your
              existing scans are unaffected.
            </p>
            <div style={{ marginTop: 28 }}>
              <button
                type="button"
                data-testid="error-retry"
                className="btn btn--primary btn--lg"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── empty state ───────────────────────────────────────────────────
  if (result === null) {
    return (
      <div className="scan">
        <div className="scan__in">
          <div className="card" data-testid="dashboard-empty" style={{ padding: "clamp(28px,4vw,48px)" }}>
            <span className="tag tag--brand">No report yet</span>
            <h2 style={{ margin: "16px 0 14px", fontSize: "clamp(26px,3vw,38px)" }}>
              Your dashboard is waiting
            </h2>
            <p className="scan__sub">
              Run your first visibility check to see your share of AI, the answers behind it, and
              which rivals are taking the recommendations you wanted.
            </p>
            <div style={{ marginTop: 28 }}>
              <button
                type="button"
                data-testid="empty-run-scan"
                className="btn btn--primary btn--lg"
                onClick={() => router.push("/scan")}
              >
                Run a visibility check
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── loading state ─────────────────────────────────────────────────
  if (result === undefined) {
    return (
      <div className="app">
        <aside className="side">
          <div className="side__brand"><div className="skel" style={{ width: 110, height: 20 }} /></div>
          <div style={{ padding: "0 10px" }}>
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="skel" style={{ height: 30, marginBottom: 6 }} />
            ))}
          </div>
        </aside>
        <main className="main">
          <div className="topbar"><div className="skel" style={{ width: 160, height: 18 }} /></div>
          <div className="viewpad">
            <div className="grid g4" style={{ marginBottom: 13 }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="skel" style={{ height: 96 }} />
              ))}
            </div>
            <div className="grid g-wide">
              <div className="skel" style={{ height: 280 }} />
              <div className="skel" style={{ height: 280 }} />
            </div>
          </div>
        </main>
      </div>
    );
  }

  const dataSourceIssue = result.dataSourceIssue;
  // Hero metric. Multi-engine: AI Visibility Index (equal-weight mean).
  // Single-engine: shareOfAiPct (the AIO-only value).
  const heroScore = result.isMultiEngine
    ? (result.visibilityIndexPct ?? result.shareOfAiPct ?? result.visibilityScore)
    : (result.shareOfAiPct ?? result.visibilityScore);
  const tier = dataSourceIssue
    ? null
    : scoreTier(heroScore, result.scoringVersion);
  const brandAliases = getBrandAliases(result.brand, result.website);

  const handleHistoryClick = (scan) => {
    setResult(normalizeResult(scan, result.brand, result.website));
  };

  const handleRerun = async () => {
    if (isScanning) return;
    setIsScanning(true);
    setRerunStage(0);
    setRerunProgress(0);
    try {
      const { runScan, saveScan } = await import("@/services/api");
      const compStr =
        result.competitorsRaw !== undefined
          ? result.competitorsRaw
          : result.competitors
          ? result.competitors.map((c) => c.name).join(", ")
          : "";
      const newResult = await runScan(
        {
          brand: result.brand,
          website: result.website,
          industry: result.industry || "",
          competitors: compStr,
        },
        (s, p) => {
          setRerunStage(s);
          setRerunProgress(p !== undefined ? p : Math.round(((s + 1) / RERUN_STAGES.length) * 100));
        }
      );
      saveScan(newResult);
      setResult(newResult);
      setScanError(null);
      fetchScanHistory(result.brand).then((scans) => setHistory(scans || []));
    } catch (e) {
      console.error("Re-run failed:", e);
      setScanError(e.message || "Failed to run scan. Please try again.");
    } finally {
      setIsScanning(false);
    }
  };

  const mentionedNonBranded = (result.rawResults || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery) &&
      !!(r.aio_present || r.aioPresent || r.answer_present) &&
      !!(r.brand_mentioned_in_text ?? r.brandMentionedInText)
  ).length;
  const citedNonBranded = (result.rawResults || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery) &&
      !!(r.aio_present || r.aioPresent || r.answer_present) &&
      !!(r.brand_cited ?? r.brandCited)
  ).length;

  const hasBrandedData = (result?.brandPresencePromptsCount ?? 0) > 0;

  const interpretation = {
    strong:
      "Your brand holds strong AI Overview presence. Defend the lead by monitoring high-intent comparison queries where rivals push hardest.",
    moderate:
      "You appear in some Google AI Overviews but miss most category queries. There is clear, addressable room to grow.",
    weak:
      "Your brand is largely absent from Google AI Overviews for its category. Competitors are winning the exact queries your buyers ask.",
  }[tier];

  const tierLabelMap = { strong: "Strong", moderate: "Moderate", weak: "Weak" };

  /* Whatever engines actually reported — not a hardcoded count of three. */
  const probeSources = result.isMultiEngine ? (result.probeSources || []) : ["aio"];

  return (
    <div className="app">
      {/* Re-run overlay */}
      {isScanning && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            display: "grid", placeItems: "center", padding: 24,
            background: "color-mix(in srgb, var(--paper) 88%, transparent)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div className="card" style={{ padding: 30, maxWidth: 460, textAlign: "center" }}>
            <Loader2 size={26} style={{ color: "var(--brand)", margin: "0 auto 14px" }} aria-hidden="true" />
            <h4 style={{ marginBottom: 8 }}>
              {RERUN_STAGES[rerunStage] || "Probing the answer engines"}
            </h4>
            <p style={{ color: "var(--ink-3)", fontSize: 14, marginBottom: 18 }}>
              This keeps updating — it is not frozen. A slow run can take several minutes.
            </p>
            <div className="probe__bar">
              <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, rerunProgress / 100))})` }} />
            </div>
            <div className="tag" style={{ marginTop: 10 }}>{rerunProgress}% complete</div>
          </div>
        </div>
      )}

      <Sidebar
        brand={result.brand}
        website={result.website}
        view={view}
        onViewChange={setView}
        history={sortedHistory}
        onHistoryClick={handleHistoryClick}
        activeScanTimestamp={result.scanTimestamp}
        onNewScan={() => router.push("/scan")}
        studioBadge={studioBadge}
        currentScore={heroScore ?? result.visibilityScore}
      />

      <main className="main">
        <div className="topbar">
          <h4>{VIEW_TITLE[view] || view}</h4>
          <span className="chip chip--you" data-testid="dashboard-brand">{result.brand}</span>
          <span className="tag">{result.website}</span>
          <span className="chip" title={`Scoring ${result.scoringVersion}`}>
            {probeSources.map(engineLabel).join(" · ")}
          </span>
          {/* A record with no collection time reads as an em dash and says so —
              it must not be indistinguishable from one collected a moment ago. */}
          {hasTimestamp(result.scanTimestamp) ? (
            <span data-testid="dashboard-timestamp" className="tag" style={{ marginLeft: "auto" }}>
              {formatTimestamp(result.scanTimestamp)} ({relativeTime(result.scanTimestamp)})
            </span>
          ) : (
            <span data-testid="dashboard-timestamp" className="tag" style={{ marginLeft: "auto" }}>
              —{" "}
              <span className="chip chip--warn" title="This record carries no collection time, so its age is unknown.">
                No collection time
              </span>
            </span>
          )}
          <ThemeToggle />
          <button
            type="button"
            data-print="hide"
            className="btn btn--ghost btn--sm"
            onClick={() => window.print()}
          >
            <Download size={14} aria-hidden="true" />
            Export
          </button>
          <button
            type="button"
            data-testid="rerun-scan-btn"
            data-print="hide"
            className="btn btn--ghost btn--sm"
            onClick={handleRerun}
            disabled={isScanning}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {isScanning ? "Scanning…" : "Re-run"}
          </button>
        </div>

        <div className="viewpad" data-testid="dashboard">
          {/* ── banners ──────────────────────────────────────────── */}
          {scanError && (
            <div className="panel" style={{ marginBottom: 16, borderColor: "var(--crit)" }}>
              <div className="panel__h">
                <span className="chip chip--crit"><i className="chip__led" /> Error</span>
                <b>{scanError}</b>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={() => setScanError(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {result.isSample && (
            <div className="panel" data-testid="sample-banner" style={{ marginBottom: 16 }}>
              <div className="panel__h">
                <span className="chip chip--warn">
                  <FlaskConical size={11} aria-hidden="true" /> Sample
                </span>
                <b>Sample report — run a real scan to analyse your own brand.</b>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={() => router.push("/scan")}
                >
                  Run a scan
                </button>
              </div>
            </div>
          )}

          {dataSourceIssue && (
            <div
              className="panel"
              data-testid="data-source-issue-banner"
              style={{ marginBottom: 16, borderColor: "var(--crit)" }}
            >
              <div className="panel__h">
                <span className="chip chip--crit">
                  <ShieldAlert size={11} aria-hidden="true" /> Incomplete
                </span>
                <b>Data source issue — scan incomplete</b>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ marginLeft: "auto" }}
                  onClick={handleRerun}
                  disabled={isScanning}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Retry scan
                </button>
              </div>
              <div className="panel__b">
                <p style={{ fontSize: 14, color: "var(--ink-3)", marginBottom: 12 }}>
                  The engines returned no answer for the majority of tracked queries, or the SERP
                  API errored out too often. We are not showing a score rather than misleading you
                  with a false 0%.
                </p>
                <div className="rows">
                  <div className="row">
                    <span className="row__n">
                      Answer coverage
                      <span className="dim">
                        (need ≥ {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}%)
                      </span>
                    </span>
                    <span className="row__v">{result.aioCoveragePct ?? 0}%</span>
                  </div>
                  <div className="row">
                    <span className="row__n">
                      SERP error rate
                      <span className="dim">(limit {AIO_ERROR_RATE_LIMIT_PCT}%)</span>
                    </span>
                    <span className="row__v">{result.aioErrorRatePct ?? 0}%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!dataSourceIssue && result.insufficientSample && (
            <div className="panel" data-testid="small-sample-warning" style={{ marginBottom: 16 }}>
              <div className="panel__h">
                <span className="chip chip--warn">Small sample</span>
                <b>
                  Only {result.queriesWithAio ?? result.nonBrandedWithAio} of{" "}
                  {result.promptsTracked ?? result.promptsAnalyzed} tracked prompts returned a live
                  answer. Treat this score with caution.
                </b>
              </div>
            </div>
          )}

          {/* ── previous readings ────────────────────────────────── */}
          {sortedHistory && sortedHistory.length > 1 && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel__h">
                <b>Previous readings</b>
                <span className="tag">{sortedHistory.length} on record</span>
              </div>
              {/* wide content scrolls inside its own container */}
              <div className="panel__b panel__b--scroll">
                <div style={{ display: "flex", gap: 10 }}>
                  {sortedHistory.map((s, i) => {
                    const isActive = sameInstant(s.scanned_at, result.scanTimestamp);
                    const next = sortedHistory[i - 1];
                    const cardDelta = next
                      ? (next.visibility_pct - (s.visibility_pct || 0)).toFixed(1)
                      : null;
                    const d = cardDelta === null ? null : parseFloat(cardDelta);
                    return (
                      <button
                        key={i}
                        type="button"
                        className="stat"
                        onClick={() => handleHistoryClick(s)}
                        style={{
                          minWidth: 148, textAlign: "left", cursor: "pointer",
                          borderColor: isActive ? "var(--brand)" : undefined,
                          background: isActive ? "var(--brand-tint)" : undefined,
                        }}
                      >
                        <span className="stat__k">{formatTimestamp(s.scanned_at)}</span>
                        <span className={`stat__v${isActive ? " is-you" : ""}`}>
                          {s.visibility_pct}<small>%</small>
                        </span>
                        <span className="stat__d">
                          {d !== null && (
                            <span className={d > 0 ? "up" : d < 0 ? "dn" : "flat"}>
                              {d > 0 ? "+" : ""}{cardDelta}
                            </span>
                          )}
                          <span className="dim">
                            {getHistoryNonBrandedCount(s)} tracked
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── the verdict ──────────────────────────────────────── */}
          {!dataSourceIssue && view === "overview" && (
            <div style={{ marginBottom: 16 }}>
              <ScoreBand
                score={heroScore}
                tier={tierLabelMap[tier]}
                trend={scoreTrend}
                promptSetChanged={!deltaSamePromptSet && !!previousScan}
                scoreLabel={result.isMultiEngine ? "AI Visibility Index" : null}
                engineChips={result.isMultiEngine && result.perEngineSummaries
                  ? Object.keys(result.perEngineSummaries).map((key) => ({
                      label: engineLabel(key),
                      value: result.perEngineSummaries[key].share_of_ai_pct ?? "—",
                    }))
                  : null
                }
                stats={[
                  {
                    value: `${result.visibleNonBranded ?? 0}/${result.nonBrandedWithAio ?? 0}`,
                    label: "answers naming you",
                  },
                  {
                    value: `${result.aioCoveragePct ?? 0}%`,
                    label: "answer coverage",
                  },
                  {
                    value: `${result.promptsAnalyzed ?? 0}`,
                    label: "queries tracked",
                  },
                ]}
              />
            </div>
          )}

          {/* ── views ────────────────────────────────────────────── */}
          {dataSourceIssue && view !== "studio" ? (
            <div className="panel" data-testid="dashboard-unreliable-placeholder">
              <div className="blank">
                <ShieldAlert size={28} style={{ color: "var(--crit)" }} aria-hidden="true" />
                <h4>Not enough answer data</h4>
                <p>
                  The engines returned an answer for less than{" "}
                  {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}% of your tracked queries. Rather
                  than pretending we have a real signal, we are showing nothing. Retry the scan, or
                  add more high-intent queries under Tracked queries.
                </p>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setView("queries")}
                >
                  Open tracked queries
                </button>
              </div>
            </div>
          ) : (
            <>
              {view === "overview" && (
                <OverviewView
                  result={result}
                  dataSourceIssue={dataSourceIssue}
                  onTabChange={setView}
                  heroScore={heroScore}
                  aioCoverage={result.aioCoveragePct}
                  nonBrandedWithAio={result.nonBrandedWithAio ?? result.queriesWithAio}
                  promptsTracked={result.promptsTracked ?? result.promptsAnalyzed}
                  presenceRate={result.presenceRatePct}
                  visibleCount={result.visibleCount ?? result.visibleNonBranded}
                  competitorsFound={result.competitorsFound}
                  promptsAnalyzed={result.promptsAnalyzed}
                  mentionedNonBrandedCount={mentionedNonBranded}
                  citedNonBrandedCount={citedNonBranded}
                  interpretation={interpretation}
                  tier={tier}
                />
              )}

              {view === "answers" && (
                <div className="stack">
                  <AnswersView
                    data-testid="non-branded-evidence"
                    title="Non-branded queries"
                    subtitle={result.isMultiEngine
                      ? "Real searches your buyers make in this category. Open a row to read the actual answer from each engine."
                      : "Real Google searches your buyers make in this category. Open a row to read the actual AI Overview."}
                    prompts={result.nonBrandedResults || []}
                    brandAliases={brandAliases}
                    emptyLabel="No non-branded queries in this scan."
                    onGenerateContent={result.isSample ? undefined : handleGenerateContent}
                  />
                  {hasBrandedData && (
                    <AnswersView
                      data-testid="branded-evidence"
                      title={`Brand presence queries (${result.brandPresencePromptsCount || 0})`}
                      subtitle="Intentional own-name searches. Excluded from the headline score, because a branded question already contains its answer."
                      prompts={result.brandPresenceResults || []}
                      brandAliases={brandAliases}
                      emptyLabel="No brand presence queries were tracked in this scan."
                    />
                  )}
                </div>
              )}

              {view === "rivals" && (
                <RivalsView
                  competitors={result.competitors}
                  results={result.rawResults || []}
                  competitorsConfigured={result.competitorsConfigured}
                  rosterSource={result.rosterSource ?? null}
                />
              )}

              {view === "sources" && <SourcesView result={result} />}

              {view === "queries" && (
                <QueriesView
                  brand={resolveBrandKey(result.brand, result.website)}
                  legacyBrand={result.brand}
                  currentPrompts={result.topPrompts || []}
                />
              )}

              {view === "crawlability" && (
                <CrawlabilityView
                  brand={resolveBrandKey(result.brand, result.website)}
                  competitors={result.competitors}
                />
              )}

              {view === "studio" && (
                <div className="stack stack--tight">
                  {studioNotice && (
                    <div className="panel" style={{ borderColor: "var(--crit)" }}>
                      <div className="panel__h">
                        <span className="chip chip--crit">Error</span>
                        <b>{studioNotice}</b>
                        <button
                          type="button"
                          className="btn btn--quiet btn--sm"
                          style={{ marginLeft: "auto" }}
                          onClick={() => setStudioNotice(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                  <StudioView
                    brand={result.brand}
                    scan={result}
                    initialItemId={studioInitialItem}
                    onCountsChange={({ awaiting }) => setStudioBadge(awaiting)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
