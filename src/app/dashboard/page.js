"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, FlaskConical, Loader2, Download, ShieldAlert, AlertCircle } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { KpiCard, HeroScoreCard } from "@/components/dashboard/KpiCard";
import { Skeleton } from "@/components/ui/skeleton";
import { CompetitorTable } from "@/components/dashboard/CompetitorTable";
import { InsightPanel } from "@/components/dashboard/InsightPanel";
import { CitationsPanel } from "@/components/dashboard/CitationsPanel";
import { AioEvidenceList } from "@/components/dashboard/AioEvidence";
import { QueryManager } from "@/components/dashboard/QueryManager";
import {
  loadScan,
  fetchScanHistory,
  normalizeResult,
  getHistoryNonBrandedCount,
} from "@/services/api";
import { scoreTier, tierLabel, formatTimestamp, relativeTime } from "@/utils/format";
import { getBrandAliases } from "@/lib/scoring/aliases";
import {
  AIO_ERROR_RATE_LIMIT_PCT,
  AIO_MIN_NON_BRANDED_COVERAGE,
  AIO_COVERAGE_WARNING_PCT,
} from "@/lib/scoring/aioConstants";

export default function Dashboard() {
  const router = useRouter();
  const [result, setResult] = useState(undefined);
  const [history, setHistory] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");

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

  const { scoreTrend, previousScan, sortedHistory } = useMemo(() => {
    let scoreTrend = null;
    let previousScan = null;
    let sortedHistory = [];
    if (!result || !history?.length) return { scoreTrend, previousScan, sortedHistory };

    sortedHistory = [...history].sort(
      (a, b) => new Date(b.scanned_at) - new Date(a.scanned_at)
    );
    const idx = sortedHistory.findIndex(
      (s) => new Date(s.scanned_at).getTime() === new Date(result.scanTimestamp).getTime()
    );
    let prev = null;
    if (idx !== -1 && idx + 1 < sortedHistory.length) prev = sortedHistory[idx + 1];
    else if (idx === -1 && sortedHistory.length > 0) prev = sortedHistory[0];

    if (prev) {
      scoreTrend = (result.visibilityScore - (prev.visibility_pct || 0)).toFixed(1);
      previousScan = normalizeResult(prev, result.brand, result.website);
    }
    return { scoreTrend, previousScan, sortedHistory };
  }, [result, history]);

  if (result === null) {
    return (
      <div className="min-h-screen bg-[#FDFBF7]">
        <Navbar />
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-28">
          <div
            data-testid="dashboard-empty"
            className="max-w-xl mx-auto text-center border border-[#E5E2D9] bg-white rounded-sm p-12"
          >
            <span className="text-xs uppercase tracking-[0.2em] text-[#D9531E] font-semibold">
              No report yet
            </span>
            <h2 className="font-serif text-4xl font-semibold text-[#1A1A1A] mt-4 leading-tight">
              Your dashboard is waiting
            </h2>
            <p className="text-[#666666] mt-4 leading-relaxed">
              Run your first Google AI Overview visibility check to see your score, top
              answers, and competitor gaps right here.
            </p>
            <button
              data-testid="empty-run-scan"
              onClick={() => router.push("/scan")}
              className="mt-8 inline-flex items-center bg-[#D9531E] text-white hover:bg-[#B34115] transition-colors rounded-sm px-8 py-4 font-sans font-semibold text-sm uppercase tracking-[0.1em]"
            >
              Run a visibility check
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (result === undefined) {
    return (
      <div className="min-h-screen bg-[#FDFBF7]">
        <Navbar />
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-28">
          <Skeleton className="h-6 bg-[#E5E2D9] w-32 mb-4 rounded-sm" />
          <Skeleton className="h-16 bg-[#E5E2D9] w-64 mb-10 rounded-sm" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5 mb-8">
            <Skeleton className="lg:col-span-2 h-40 bg-[#E5E2D9] rounded-sm" />
            <Skeleton className="h-40 bg-[#E5E2D9] rounded-sm" />
            <Skeleton className="h-40 bg-[#E5E2D9] rounded-sm" />
            <Skeleton className="h-40 bg-[#E5E2D9] rounded-sm" />
          </div>
        </div>
      </div>
    );
  }

  const dataSourceIssue = result.dataSourceIssue;
  const tier = dataSourceIssue
    ? null
    : scoreTier(result.visibilityScore, result.scoringVersion);
  const brandAliases = getBrandAliases(result.brand, result.website);

  const handleHistoryClick = (scan) => {
    setResult(normalizeResult(scan, result.brand, result.website));
  };

  const handleRerun = async () => {
    if (isScanning) return;
    setIsScanning(true);
    try {
      const { runScan, saveScan } = await import("@/services/api");
      const compStr =
        result.competitorsRaw !== undefined
          ? result.competitorsRaw
          : result.competitors
          ? result.competitors.map((c) => c.name).join(", ")
          : "";
      const newResult = await runScan({
        brand: result.brand,
        website: result.website,
        industry: result.industry || "",
        competitors: compStr,
      });
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
      !!(r.aio_present ?? r.aioPresent) &&
      !!(r.brand_mentioned_in_text ?? r.brandMentionedInText)
  ).length;
  const citedNonBranded = (result.rawResults || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery) &&
      !!(r.aio_present ?? r.aioPresent) &&
      !!(r.brand_cited ?? r.brandCited)
  ).length;

  return (
    <div className="min-h-screen bg-[#FDFBF7] relative print:bg-white">
      {isScanning && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm transition-opacity duration-300">
          <Loader2 className="w-12 h-12 text-[#D9531E] animate-spin mb-4" />
          <h2 className="font-serif text-2xl font-semibold text-[#1A1A1A]">
            Probing Google AI Overview
          </h2>
          <p className="text-[#666666] mt-2">
            Running live queries against Bright Data. This usually takes 60-90 seconds.
          </p>
        </div>
      )}

      <Navbar />
      <div
        className="max-w-7xl mx-auto px-6 md:px-12 py-10 md:py-14"
        data-testid="dashboard"
      >
        {scanError && (
          <div className="mb-6 p-4 bg-[#F9ECEC] border border-[#E2B8B8] rounded-sm text-[#8B3A3A] text-sm flex items-center justify-between">
            <span>{scanError}</span>
            <button
              onClick={() => setScanError(null)}
              className="text-[#8B3A3A] font-semibold hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}
        {result.isSample && (
          <div
            data-testid="sample-banner"
            className="mb-8 flex items-center gap-2.5 bg-[#FDF6E3] border border-[#E6D5A7] rounded-sm px-4 py-3 text-sm text-[#8F6614]"
          >
            <FlaskConical className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            Sample report — run a real scan to analyze your own brand.
          </div>
        )}

        {/* Title bar */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-8 border-b border-[#E5E2D9] mb-10">
          <div>
            <span className="text-xs uppercase tracking-[0.15em] text-[#666666] font-medium">
              Google AI Overview visibility
            </span>
            <h1
              data-testid="dashboard-brand"
              className="font-serif text-5xl md:text-6xl font-semibold tracking-tight text-[#1A1A1A] leading-none mt-2"
            >
              {result.brand}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 text-sm text-[#666666]">
              <span className="font-medium text-[#1A1A1A]">{result.website}</span>
              <span className="text-[#CCCCCC]">·</span>
              <span data-testid="dashboard-timestamp">
                Last scan {formatTimestamp(result.scanTimestamp)} (
                {relativeTime(result.scanTimestamp)})
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#EBF3FF] text-[#4B6B94] border border-[#BACEEA] uppercase font-bold tracking-wider">
                Source: Google AIO
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#F3F0E6] text-[#666666] border border-[#E5E2D9] uppercase font-bold tracking-wider">
                {result.scoringVersion}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 self-start md:self-auto print:hidden">
            <button
              onClick={() => window.print()}
              className="group inline-flex items-center gap-2 bg-transparent border border-[#E5E2D9] hover:border-[#1A1A1A] text-[#1A1A1A] transition-colors rounded-sm px-6 py-3 font-sans font-semibold text-xs uppercase tracking-[0.1em]"
            >
              <Download className="w-4 h-4 group-hover:-translate-y-0.5 transition-transform" strokeWidth={1.5} />
              Export
            </button>
            <button
              data-testid="rerun-scan-btn"
              onClick={handleRerun}
              disabled={isScanning}
              className={`group inline-flex items-center gap-2 bg-transparent border transition-colors rounded-sm px-6 py-3 font-sans font-semibold text-xs uppercase tracking-[0.1em] ${
                isScanning
                  ? "text-[#999999] border-[#E5E2D9] cursor-not-allowed"
                  : "text-[#1A1A1A] border-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white"
              }`}
            >
              <RefreshCw
                className={`w-4 h-4 ${
                  isScanning ? "animate-spin" : "group-hover:rotate-180 transition-transform duration-500"
                }`}
                strokeWidth={1.5}
              />
              {isScanning ? "Scanning..." : "Re-run"}
            </button>
          </div>
        </div>

        {/* Data-source issue banner */}
        {dataSourceIssue && (
          <div
            data-testid="data-source-issue-banner"
            className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-6 bg-[#F9ECEC] border border-[#E2B8B8] rounded-sm p-6 text-[#8B3A3A]"
          >
            <div>
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5" />
                <h4 className="font-serif text-lg font-bold">Data source issue — scan incomplete</h4>
              </div>
              <p className="text-sm mt-2 text-[#8B3A3A]/90 max-w-2xl">
                Bright Data returned no AI Overview for the majority of tracked queries,
                or the SERP API errored out too often. We are not showing a visibility
                score to avoid misleading you with a false 0%.
              </p>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs font-semibold text-[#8B3A3A]/80">
                <span>
                  AIO coverage:{" "}
                  <span className="text-[#8B3A3A] font-bold">
                    {result.aioCoveragePct ?? 0}%
                  </span>{" "}
                  (need ≥ {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}%)
                </span>
                <span>
                  SERP error rate:{" "}
                  <span className="text-[#8B3A3A] font-bold">
                    {result.aioErrorRatePct ?? 0}%
                  </span>{" "}
                  (limit {AIO_ERROR_RATE_LIMIT_PCT}%)
                </span>
              </div>
            </div>
            <button
              onClick={handleRerun}
              disabled={isScanning}
              className="inline-flex items-center gap-2 bg-[#8B3A3A] hover:bg-[#8B3A3A]/90 text-white transition-colors rounded-sm px-6 py-3 font-sans font-semibold text-xs uppercase tracking-[0.1em] self-start md:self-auto shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${isScanning ? "animate-spin" : ""}`} />
              Retry scan
            </button>
          </div>
        )}

        {!dataSourceIssue && result.insufficientSample && (
          <div
            className="mb-8 flex items-start gap-4 bg-[#FCF8E3] border border-[#F5E7B8] rounded-sm p-5 text-[#8A6D3B]"
            data-testid="small-sample-warning"
          >
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0 text-[#8A6D3B]" />
            <p className="text-sm text-[#8A6D3B]/90">
              Only {result.nonBrandedWithAio} non-branded queries had a live AI Overview (of{" "}
              {result.promptsAnalyzed} non-branded tracked). Treat this score with caution.
            </p>
          </div>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-5 mb-8">
          <div className="lg:col-span-2">
            <HeroScoreCard
              testId="kpi-visibility-score"
              score={dataSourceIssue ? "—" : result.visibilityScore}
              tierText={dataSourceIssue ? "Unavailable" : tierLabel(tier)}
              trend={dataSourceIssue ? null : scoreTrend}
              mentionRate={dataSourceIssue ? undefined : result.mentionRatePct}
              citationShare={dataSourceIssue ? undefined : result.brandCitationSharePct}
              aioCoverage={dataSourceIssue ? undefined : result.aioCoveragePct}
              nonBrandedCount={dataSourceIssue ? undefined : result.promptsAnalyzed}
              nonBrandedWithAio={
                dataSourceIssue ? undefined : result.nonBrandedWithAio
              }
              visibleNonBranded={
                dataSourceIssue ? undefined : result.visibleNonBranded
              }
              mentionedNonBranded={
                dataSourceIssue ? undefined : mentionedNonBranded
              }
              citedNonBranded={dataSourceIssue ? undefined : citedNonBranded}
              brandedVisibility={
                dataSourceIssue || result.brandPresencePromptsCount === 0
                  ? undefined
                  : result.brandedVisibilityPct
              }
            />
          </div>
          <KpiCard
            testId="kpi-aio-coverage"
            label="AIO Coverage"
            value={dataSourceIssue ? "—" : result.aioCoveragePct ?? 0}
            suffix="%"
            tone={
              dataSourceIssue
                ? "critical"
                : (result.aioCoveragePct ?? 0) < AIO_COVERAGE_WARNING_PCT
                ? "warning"
                : "good"
            }
            sub={`${result.nonBrandedWithAio ?? 0} of ${result.promptsAnalyzed} non-branded queries returned an AI Overview`}
            index={1}
          />
          <KpiCard
            testId="kpi-brand-presence"
            label="Brand Presence"
            value={
              dataSourceIssue || result.brandPresencePromptsCount === 0
                ? "—"
                : result.brandedVisibilityPct
            }
            suffix={
              dataSourceIssue || result.brandPresencePromptsCount === 0 ? "" : "%"
            }
            sub={`${result.brandPresenceWithAio ?? result.brandedWithAio ?? 0} of ${
              result.brandPresencePromptsCount || 0
            } own-name queries had an AIO`}
            index={2}
          />
          <KpiCard
            testId="kpi-prompts"
            label="Tracked Queries"
            value={
              result.queriesTracked ??
              (result.rawResults?.length ||
                result.promptsAnalyzed + (result.brandedPromptsCount || 0))
            }
            sub={(() => {
              const nonB = result.promptsAnalyzed || 0;
              const own = result.brandPresencePromptsCount || 0;
              const other =
                result.aliasBrandedOnlyCount ??
                Math.max(0, (result.brandedPromptsCount || 0) - own);
              if (other > 0) {
                return `${nonB} non-branded · ${own} own-name · ${other} other branded`;
              }
              return `${nonB} non-branded · ${own} own-name`;
            })()}
            index={3}
          />
          <KpiCard
            testId="kpi-competitors"
            label="Competitors Found"
            value={result.competitorsFound ?? 0}
            sub={
              (result.competitorsFound ?? 0) === 0
                ? "None co-mentioned in AIOs"
                : "Auto-found in AI Overviews"
            }
            index={4}
          />
        </div>

        {/* History Row */}
        {sortedHistory && sortedHistory.length > 1 && (
          <div className="mb-8 p-5 bg-white border border-[#E5E2D9] rounded-sm">
            <h3 className="text-xs font-semibold text-[#1A1A1A] mb-4 uppercase tracking-[0.1em]">
              Previous Scans
            </h3>
            <div className="flex gap-4 overflow-x-auto pb-2">
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
                    className={`min-w-[140px] text-left p-4 border rounded-sm transition-colors ${
                      isActive
                        ? "border-[#D9531E] bg-[#FFF8F5]"
                        : "border-[#E5E2D9] bg-[#FDFBF7] hover:border-[#1A1A1A]"
                    }`}
                  >
                    <div className="text-xs text-[#666666] whitespace-nowrap">
                      {formatTimestamp(scan.scanned_at)}
                    </div>
                    <div className="text-xl font-serif font-bold text-[#D9531E] mt-2">
                      {scan.visibility_pct}%
                    </div>
                    {cardDelta !== null && (
                      <div
                        className={`text-[10px] mt-0.5 font-semibold ${
                          parseFloat(cardDelta) > 0
                            ? "text-[#2F5C4F]"
                            : parseFloat(cardDelta) < 0
                            ? "text-[#8B3A3A]"
                            : "text-[#999999]"
                        }`}
                      >
                        {parseFloat(cardDelta) > 0 ? "+" : ""}
                        {cardDelta}%
                      </div>
                    )}
                    <div className="text-xs text-[#999999] mt-1">
                      {getHistoryNonBrandedCount(scan)} non-branded tracked
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {dataSourceIssue ? (
          <div
            className="bg-white border border-[#E5E2D9] rounded-sm p-12 text-center max-w-2xl mx-auto my-12"
            data-testid="dashboard-unreliable-placeholder"
          >
            <ShieldAlert
              className="w-12 h-12 text-[#8B3A3A] mx-auto mb-4"
              strokeWidth={1.5}
            />
            <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A]">
              Not enough AI Overview data
            </h3>
            <p className="text-[#666666] mt-3 text-sm leading-relaxed">
              Bright Data returned an AI Overview for less than{" "}
              {Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}% of your tracked
              queries. Rather than pretending we have a real signal, we&apos;re showing
              nothing. Retry the scan or add more high-intent queries in the &quot;Tracked
              Queries&quot; tab.
            </p>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex items-center gap-6 border-b border-[#E5E2D9] mb-8 overflow-x-auto pb-px print:hidden">
              {["overview", "brand-presence", "queries", "citations"].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  data-testid={`tab-${tab}`}
                  className={`pb-4 text-sm font-semibold uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${
                    activeTab === tab
                      ? "border-[#1A1A1A] text-[#1A1A1A]"
                      : "border-transparent text-[#999999] hover:text-[#1A1A1A]"
                  }`}
                >
                  {tab === "brand-presence"
                    ? "Brand Presence"
                    : tab === "citations"
                    ? "Citations & Sources"
                    : tab === "queries"
                    ? "Tracked Queries"
                    : "Overview"}
                </button>
              ))}
            </div>

            {activeTab === "overview" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-8">
                  <AioEvidenceList
                    testId="non-branded-evidence"
                    title="Non-branded queries"
                    subtitle="Real Google searches your buyers make in this category. Click a row to see the actual AI Overview."
                    prompts={result.nonBrandedResults}
                    brandAliases={brandAliases}
                    emptyLabel="No non-branded queries in this scan."
                  />
                  <CompetitorTable
                    competitors={result.competitors}
                    results={result.rawResults || []}
                    competitorsConfigured={result.competitorsConfigured}
                  />
                </div>
                <div className="lg:col-span-1 space-y-8">
                  <div className="lg:sticky lg:top-24 space-y-8">
                    <InsightPanel result={result} trend={scoreTrend} onRerun={handleRerun} />
                  </div>
                </div>
              </div>
            )}

            {activeTab === "brand-presence" && (
              <div className="space-y-6">
                <div className="bg-[#FFFBF6] border border-[#E5E2D9] rounded-sm p-6">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-[#D9531E] font-bold">
                    Branded queries panel
                  </span>
                  <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] mt-1">
                    How Google answers when people search for {result.brand} directly
                  </h3>
                  <p className="text-sm text-[#666666] mt-2 max-w-3xl">
                    These queries contain your brand name so they are excluded from the
                    headline score. They still matter — this is how Google frames your
                    brand when someone already knows about you.
                  </p>
                </div>
                <AioEvidenceList
                  testId="branded-evidence"
                  title={`Brand presence queries (${result.brandPresencePromptsCount || 0})`}
                  subtitle="Intentional own-name searches (branded seeds). Excluded from the headline visibility score."
                  prompts={result.brandPresenceResults}
                  brandAliases={brandAliases}
                  emptyLabel="No brand presence queries were tracked in this scan."
                />
              </div>
            )}

            {activeTab === "queries" && (
              <QueryManager
                brand={result.brand}
                currentPrompts={result.topPrompts}
              />
            )}

            {activeTab === "citations" && <CitationsPanel result={result} />}
          </>
        )}
      </div>
    </div>
  );
}
