"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, FlaskConical, Loader2, Download, ShieldAlert, AlertCircle } from "lucide-react";
import { Sidebar } from "@/components/perceev/Sidebar";
import { Skeleton } from "@/components/perceev/Skeleton";
import { Button } from "@/components/perceev/Button";
import { ScoreMeter } from "@/components/perceev/ScoreMeter";
import { Alert } from "@/components/perceev/Alert";
import { ScoreBand } from "@/components/dashboard/ScoreBand";
import { OverviewView } from "@/components/dashboard/OverviewView";
import { AnswersView } from "@/components/dashboard/AnswersView";
import { RivalsView } from "@/components/dashboard/RivalsView";
import { SourcesView } from "@/components/dashboard/SourcesView";
import { QueriesView } from "@/components/dashboard/QueriesView";
import { StudioView } from "@/components/studio/StudioView";
import {
  loadScan,
  fetchScanHistory,
  normalizeResult,
  getHistoryNonBrandedCount,
} from "@/services/api";
import { scoreTier, tierLabel, formatTimestamp, relativeTime } from "@/utils/format";
import { getBrandAliases } from "@/lib/scoring/aliases";
import { resolveBrandKey } from "@/lib/scoring/brandKey";
import {
  AIO_ERROR_RATE_LIMIT_PCT,
  AIO_MIN_NON_BRANDED_COVERAGE,
  AIO_COVERAGE_WARNING_PCT,
} from "@/lib/scoring/aioConstants";

const RERUN_STAGES = [
  "Submitting brand for analysis",
  "Sourcing real Google queries",
  "Probing Google AI Overview via Bright Data",
  "Scoring visibility & composing evidence",
];

export default function Dashboard() {
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

  // Deep-link support: /dashboard?view=studio&item=<id> lands directly on a
  // run from the homepage workspace. Read once from the URL on mount.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get("view");
      const validViews = ["overview", "answers", "rivals", "sources", "queries", "studio"];
      if (v && validViews.includes(v)) setView(v);
      const item = params.get("item");
      if (item) setStudioInitialItem(item);
    } catch {
      /* no-op */
    }
  }, []);

  useEffect(() => {
    const current = loadScan();
    const normalized = current
      ? normalizeResult(current, current.brand, current.website)
      : current;
    setResult(normalized);
    if (normalized && normalized.brand && !normalized.isSample) {
      fetchScanHistory(normalized.brand).then((scans) => setHistory(scans || []));
    }
  }, []);

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
    const idx = sortedHistory.findIndex(
      (s) => new Date(s.scanned_at).getTime() === new Date(result.scanTimestamp).getTime()
    );
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

  // Empty state
  if (result === null) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-0)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div
          data-testid="dashboard-empty"
          style={{
            maxWidth: "420px",
            margin: "0 auto",
            textAlign: "center",
            background: "var(--bg-1)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--radius-2)",
            padding: "var(--space-9)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--accent-text)",
            }}
          >
            No report yet
          </span>
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-h1)",
              fontWeight: 600,
              letterSpacing: "var(--track-h1)",
              color: "var(--text-1)",
              marginTop: "var(--space-4)",
            }}
          >
            Your dashboard is waiting
          </h2>
          <p
            style={{
              color: "var(--text-2)",
              marginTop: "var(--space-4)",
              lineHeight: 1.55,
              fontSize: "14px",
            }}
          >
            Run your first Google AI Overview visibility check to see your score, top
            answers, and competitor gaps right here.
          </p>
          <div style={{ marginTop: "var(--space-8)" }}>
            <Button
              data-testid="empty-run-scan"
              variant="primary"
              size="lg"
              onClick={() => router.push("/scan")}
            >
              Run a visibility check
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (result === undefined) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg-0)", display: "flex" }}>
        <Sidebar />
        <main style={{ flex: 1, padding: "var(--space-9)" }}>
          <div style={{ maxWidth: "900px" }}>
            <Skeleton style={{ height: "16px", width: "120px", marginBottom: "var(--space-4)" }} />
            <Skeleton style={{ height: "48px", width: "280px", marginBottom: "var(--space-9)" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--space-5)", marginBottom: "var(--space-8)" }}>
              <Skeleton style={{ height: "180px" }} />
              <Skeleton style={{ height: "180px" }} />
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

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-0)", display: "flex" }}>
      {/* Scanning overlay */}
      {isScanning && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(14,13,11, 0.85)",
            backdropFilter: "var(--blur-overlay)",
            WebkitBackdropFilter: "var(--blur-overlay)",
          }}
        >
          <Loader2
            size={40}
            style={{ color: "var(--accent)", animation: "spin 1s linear infinite", marginBottom: "var(--space-4)" }}
          />
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "20px",
              fontWeight: 600,
              color: "var(--text-1)",
            }}
          >
            {RERUN_STAGES[rerunStage] || "Probing Google AI Overview"} ({rerunProgress}%)
          </h2>
          <p style={{ color: "var(--text-2)", marginTop: "var(--space-2)", fontSize: "14px" }}>
            Probing live Google AI Overview via Bright Data. Can take several minutes if the
            SERP provider is retrying — this will keep updating, it isn&apos;t frozen.
          </p>
          <div style={{ marginTop: "var(--space-6)", width: "260px" }}>
            <ScoreMeter segments={20} value={rerunProgress} />
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
      />

      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflow: "hidden",
        }}
      >
        {/* Header strip */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--space-5) var(--space-7)",
            borderBottom: "1px solid var(--border-1)",
            background: "var(--bg-0)",
            flexShrink: 0,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--text-3)",
              }}
            >
              {view === "overview"
                ? "Visibility Overview"
                : view === "answers"
                ? "Answers"
                : view === "rivals"
                ? "Rivals"
                : view === "sources"
                ? "Sources"
                : view === "studio"
                ? "Content Studio"
                : "Tracked Queries"}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)", marginTop: "2px" }}>
              <h1
                data-testid="dashboard-brand"
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "20px",
                  fontWeight: 600,
                  color: "var(--text-1)",
                  letterSpacing: "-0.01em",
                }}
              >
                {result.brand}
              </h1>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: "var(--text-3)",
                }}
              >
                {result.website}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <span
              data-testid="dashboard-timestamp"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                color: "var(--text-3)",
                marginRight: "var(--space-2)",
              }}
            >
              {formatTimestamp(result.scanTimestamp)} ({relativeTime(result.scanTimestamp)})
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                padding: "2px 8px",
                borderRadius: "var(--radius-1)",
                background: "var(--info-bg)",
                color: "var(--info)",
                border: "1px solid var(--info-border)",
              }}
            >
              {result.isMultiEngine
                ? `Sources: ${(result.probeSources || []).map((s) => s === "aio" ? "AIO" : s === "chatgpt" ? "ChatGPT" : s === "perplexity" ? "PPLX" : s.toUpperCase()).join(" + ")}`
                : "Source: Google AIO"}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                padding: "2px 8px",
                borderRadius: "var(--radius-1)",
                background: "var(--bg-2)",
                color: "var(--text-2)",
                border: "1px solid var(--border-2)",
              }}
            >
              {result.scoringVersion}
            </span>
            <Button data-print="hide" variant="secondary" size="sm" onClick={() => window.print()}>
              <Download size={14} />
              Export
            </Button>
            <Button
              data-testid="rerun-scan-btn"
              data-print="hide"
              variant="secondary"
              size="sm"
              onClick={handleRerun}
              disabled={isScanning}
            >
              <RefreshCw size={14} className={isScanning ? "animate-spin" : ""} />
              {isScanning ? "Scanning..." : "Re-run"}
            </Button>
          </div>
        </header>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflow: "auto", padding: "var(--space-7)" }} data-testid="dashboard">
          {/* Banners */}
          {scanError && (
            <div style={{ marginBottom: "var(--space-6)" }}>
              <Alert variant="crit" onDismiss={() => setScanError(null)}>
                {scanError}
              </Alert>
            </div>
          )}

          {result.isSample && (
            <div style={{ marginBottom: "var(--space-6)" }}>
              <Alert data-testid="sample-banner" variant="warn">
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <FlaskConical size={16} />
                  Sample report — run a real scan to analyze your own brand.
                </div>
              </Alert>
            </div>
          )}

          {/* Data-source issue banner */}
          {dataSourceIssue && (
            <div style={{ marginBottom: "var(--space-6)" }}>
              <Alert
                data-testid="data-source-issue-banner"
                variant="crit"
                title={
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <ShieldAlert size={18} />
                    Data source issue — scan incomplete
                  </div>
                }
                action={
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleRerun}
                    disabled={isScanning}
                  >
                    <RefreshCw size={14} />
                    Retry scan
                  </Button>
                }
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  <p>
                    Bright Data returned no AI Overview for the majority of tracked queries,
                    or the SERP API errored out too often. We are not showing a visibility
                    score to avoid misleading you with a false 0%.
                  </p>
                  <div style={{ display: "flex", gap: "var(--space-6)", flexWrap: "wrap", fontSize: "11px", fontWeight: 600 }}>
                    <span>
                      AIO coverage: <strong>{result.aioCoveragePct ?? 0}%</strong>{" "}
                      (need ≥ {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}%)
                    </span>
                    <span>
                      SERP error rate: <strong>{result.aioErrorRatePct ?? 0}%</strong>{" "}
                      (limit {AIO_ERROR_RATE_LIMIT_PCT}%)
                    </span>
                  </div>
                </div>
              </Alert>
            </div>
          )}

          {!dataSourceIssue && result.insufficientSample && (
            <div style={{ marginBottom: "var(--space-6)" }}>
              <Alert
                data-testid="small-sample-warning"
                variant="warn"
              >
                Only {result.queriesWithAio ?? result.nonBrandedWithAio} of{" "}
                {result.promptsTracked ?? result.promptsAnalyzed} tracked prompts had a live AI
                Overview. Treat this score with caution.
              </Alert>
            </div>
          )}

          {/* History row */}
          {sortedHistory && sortedHistory.length > 1 && (
            <div
              style={{
                marginBottom: "var(--space-6)",
                background: "var(--bg-1)",
                border: "1px solid var(--border-1)",
                borderRadius: "var(--radius-2)",
                padding: "var(--space-5)",
              }}
            >
              <h3
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--text-2)",
                  marginBottom: "var(--space-4)",
                }}
              >
                Previous Scans
              </h3>
              <div style={{ display: "flex", gap: "var(--space-4)", overflowX: "auto", paddingBottom: "var(--space-2)" }}>
                {sortedHistory.map((scan, i) => {
                  const isActive =
                    new Date(scan.scanned_at).getTime() ===
                    new Date(result.scanTimestamp).getTime();
                  const next = sortedHistory[i - 1];
                  const cardDelta = next
                    ? (next.visibility_pct - (scan.visibility_pct || 0)).toFixed(1)
                    : null;
                  return (
                    <button
                      key={i}
                      onClick={() => handleHistoryClick(scan)}
                      style={{
                        minWidth: "130px",
                        textAlign: "left",
                        padding: "var(--space-4)",
                        borderRadius: "var(--radius-1)",
                        border: isActive
                          ? "1px solid var(--accent-border)"
                          : "1px solid var(--border-1)",
                        background: isActive ? "var(--accent-soft)" : "var(--bg-0)",
                        cursor: "pointer",
                        transition: "all var(--dur-fast)",
                      }}
                    >
                      <div style={{ fontSize: "11px", color: "var(--text-3)", whiteSpace: "nowrap" }}>
                        {formatTimestamp(scan.scanned_at)}
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: "20px",
                          fontWeight: 600,
                          color: "var(--accent)",
                          marginTop: "var(--space-2)",
                        }}
                      >
                        {scan.visibility_pct}%
                      </div>
                      {cardDelta !== null && (
                        <div
                          style={{
                            fontSize: "10px",
                            marginTop: "2px",
                            fontWeight: 600,
                            color:
                              parseFloat(cardDelta) > 0
                                ? "var(--good)"
                                : parseFloat(cardDelta) < 0
                                ? "var(--crit)"
                                : "var(--text-3)",
                          }}
                        >
                          {parseFloat(cardDelta) > 0 ? "+" : ""}
                          {cardDelta}%
                        </div>
                      )}
                      <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "var(--space-1)" }}>
                        {getHistoryNonBrandedCount(scan)} non-branded tracked
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ScoreBand — only on overview and no dataSourceIssue */}
          {!dataSourceIssue && view === "overview" && (
            <div style={{ marginBottom: "var(--space-6)" }}>
              <ScoreBand
                score={heroScore}
                tier={tierLabelMap[tier]}
                trend={scoreTrend}
                promptSetChanged={!deltaSamePromptSet && !!previousScan}
                scoreLabel={result.isMultiEngine ? "AI Visibility Index" : null}
                engineChips={result.isMultiEngine && result.perEngineSummaries
                  ? [
                      { key: "aio", label: "AIO" },
                      { key: "chatgpt", label: "ChatGPT" },
                      { key: "perplexity", label: "PPLX" },
                    ]
                      .filter(({ key }) => result.perEngineSummaries[key])
                      .map(({ key, label }) => ({
                        label,
                        value: result.perEngineSummaries[key].share_of_ai_pct ?? "—",
                      }))
                  : null
                }
                stats={[
                  {
                    value: `${result.visibleNonBranded ?? 0}/${result.nonBrandedWithAio ?? 0}`,
                    label: "visible in AI Overviews",
                  },
                  {
                    value: `${result.aioCoveragePct ?? 0}%`,
                    label: "AIO coverage",
                  },
                  {
                    value: `${result.promptsAnalyzed ?? 0}`,
                    label: "queries tracked",
                  },
                ]}
              />
            </div>
          )}

          {/* Content area — dataSourceIssue placeholder (Studio stays reachable) */}
          {dataSourceIssue && view !== "studio" ? (
            <div
              data-testid="dashboard-unreliable-placeholder"
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--border-1)",
                borderRadius: "var(--radius-2)",
                padding: "var(--space-9)",
                textAlign: "center",
                maxWidth: "600px",
                margin: "var(--space-9) auto",
              }}
            >
              <ShieldAlert
                size={40}
                style={{ color: "var(--crit)", margin: "0 auto var(--space-4)" }}
              />
              <h3
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "20px",
                  fontWeight: 600,
                  color: "var(--text-1)",
                }}
              >
                Not enough AI Overview data
              </h3>
              <p
                style={{
                  color: "var(--text-2)",
                  marginTop: "var(--space-3)",
                  fontSize: "13px",
                  lineHeight: 1.55,
                }}
              >
                Bright Data returned an AI Overview for less than{" "}
                {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}% of your tracked
                queries. Rather than pretending we have a real signal, we&apos;re showing
                nothing. Retry the scan or add more high-intent queries in the &quot;Tracked
                Queries&quot; tab.
              </p>
            </div>
          ) : (
            <>
              {/* View routing */}
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
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)", height: "100%" }}>
                  <AnswersView
                    data-testid="non-branded-evidence"
                    title="Non-branded queries"
                    subtitle={result.isMultiEngine
                      ? "Real searches your buyers make in this category. Click a row to see the actual AI answer from each engine."
                      : "Real Google searches your buyers make in this category. Click a row to see the actual AI Overview."}
                    prompts={result.nonBrandedResults || []}
                    brandAliases={brandAliases}
                    emptyLabel="No non-branded queries in this scan."
                    onGenerateContent={result.isSample ? undefined : handleGenerateContent}
                  />
                  {hasBrandedData && (
                    <AnswersView
                      data-testid="branded-evidence"
                      title={`Brand presence queries (${result.brandPresencePromptsCount || 0})`}
                      subtitle="Intentional own-name searches (branded seeds). Excluded from the headline visibility score."
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

              {view === "studio" && (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
                  {studioNotice && (
                    <Alert variant="crit" onDismiss={() => setStudioNotice(null)}>
                      {studioNotice}
                    </Alert>
                  )}
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <StudioView
                      brand={result.brand}
                      scan={result}
                      initialItemId={studioInitialItem}
                      onCountsChange={({ awaiting }) => setStudioBadge(awaiting)}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
