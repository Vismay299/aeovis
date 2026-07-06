"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, FlaskConical, Loader2, Download } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { KpiCard, HeroScoreCard } from "@/components/dashboard/KpiCard";
import { Skeleton } from "@/components/ui/skeleton";
import { TopPromptsTable } from "@/components/dashboard/TopPromptsTable";
import { CompetitorTable } from "@/components/dashboard/CompetitorTable";
import { InsightPanel } from "@/components/dashboard/InsightPanel";
import { OpportunitiesPanel } from "@/components/dashboard/OpportunitiesPanel";
import { CitationsPanel } from "@/components/dashboard/CitationsPanel";
import { loadScan, fetchScanHistory, normalizeResult } from "@/services/api";
import { scoreTier, tierLabel, formatTimestamp, relativeTime } from "@/utils/format";
import { ScoreBreakdown } from "@/components/dashboard/ScoreBreakdown";
import { QueryManager } from "@/components/dashboard/QueryManager";

export default function Dashboard() {
  const router = useRouter();
  const [result, setResult] = useState(undefined);
  const [history, setHistory] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    const current = loadScan();
    setResult(current);
    if (current && current.brand && !current.isSample) {
      fetchScanHistory(current.brand).then(scans => {
        setHistory(scans || []);
      });
    }
  }, []);

  const { scoreTrend, previousScan, sortedHistory, topPromptsWithTrend, competitorsWithTrend, isMixedTrend, promptSetChanged } = React.useMemo(() => {
    let scoreTrend = null;
    let previousScan = null;
    let sortedHistory = [];
    let topPromptsWithTrend = [];
    let competitorsWithTrend = [];
    let isMixedTrend = false;
    let promptSetChanged = false;

    if (!result) return { scoreTrend, previousScan, sortedHistory, topPromptsWithTrend, competitorsWithTrend, isMixedTrend, promptSetChanged };

    if (history && history.length > 0) {
      sortedHistory = [...history].sort((a,b) => new Date(b.scanned_at) - new Date(a.scanned_at));
      const idx = sortedHistory.findIndex(s => new Date(s.scanned_at).getTime() === new Date(result.scanTimestamp).getTime());
      if (idx !== -1 && idx + 1 < sortedHistory.length) {
        const prev = sortedHistory[idx + 1];
        scoreTrend = (result.visibilityScore - (prev.visibility_pct || 0)).toFixed(1);
        previousScan = normalizeResult(prev, result.brand, result.website);
        
        const prevVersion = prev.scoring_version ?? prev.raw_results?.scoring_version ?? "v1-binary";
        if (prevVersion !== result.scoringVersion) {
          isMixedTrend = true;
        }

        const prevHash = prev.prompt_set_hash ?? prev.raw_results?.prompt_set_hash ?? "";
        if (prevHash && result.promptSetHash && prevHash !== result.promptSetHash) {
          promptSetChanged = true;
        }
      } else if (idx === -1 && sortedHistory.length > 0) {
        // result not in history yet
        const prev = sortedHistory[0];
        scoreTrend = (result.visibilityScore - (prev.visibility_pct || 0)).toFixed(1);
        previousScan = normalizeResult(prev, result.brand, result.website);
        
        const prevVersion = prev.scoring_version ?? prev.raw_results?.scoring_version ?? "v1-binary";
        if (prevVersion !== result.scoringVersion) {
          isMixedTrend = true;
        }

        const prevHash = prev.prompt_set_hash ?? prev.raw_results?.prompt_set_hash ?? "";
        if (prevHash && result.promptSetHash && prevHash !== result.promptSetHash) {
          promptSetChanged = true;
        }
      }
    }

    // Sort prompts by rank / visibility
    const sortedPrompts = [...(result.topPrompts || [])].sort((a, b) => {
      if (a.rank === "—") return 1;
      if (b.rank === "—") return -1;
      return a.rank - b.rank;
    });

    topPromptsWithTrend = sortedPrompts.map(p => {
      if (previousScan && previousScan.topPrompts) {
        const prevP = previousScan.topPrompts.find(pp => pp.prompt.toLowerCase() === p.prompt.toLowerCase());
        if (prevP) {
          const prevRank = prevP.rank === "—" || prevP.rank == null ? 100 : prevP.rank;
          const currRank = p.rank === "—" || p.rank == null ? 100 : p.rank;
          const trend = prevRank - currRank;
          return { ...p, trend };
        }
      }
      return p;
    });

    competitorsWithTrend = (result.competitors || []).map(c => {
      if (previousScan && previousScan.competitors) {
        const prevC = previousScan.competitors.find(pc => pc.name.toLowerCase() === c.name.toLowerCase());
        if (prevC) {
          const trend = c.visibilityScore - prevC.visibilityScore;
          return { ...c, trend };
        }
      }
      return c;
    });

    return { scoreTrend, previousScan, sortedHistory, topPromptsWithTrend, competitorsWithTrend, isMixedTrend, promptSetChanged };
  }, [result, history]);

  const resultWithFlags = React.useMemo(() => {
    if (!result) return null;
    return { ...result, promptSetChanged };
  }, [result, promptSetChanged]);

  // Empty state — no scan yet
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
              Run your first visibility check to see your AI Visibility Score, top prompts, and
              competitor gaps right here.
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

  const tier = scoreTier(result.visibilityScore, result.scoringVersion);

  const handleHistoryClick = (scan) => {
    // Re-normalize raw DB row into frontend shape
    setResult(normalizeResult(scan, result.brand, result.website));
  };

  const handleRerun = async () => {
    if (isScanning) return;
    setIsScanning(true);
    try {
      const { runScan, saveScan } = await import("@/services/api");
      // Grab input competitors if possible, or fallback to mapped ones
      const compStr = result.competitorsRaw !== undefined ? result.competitorsRaw : (result.competitors ? result.competitors.map(c => c.name).join(", ") : "");
      const newResult = await runScan({ 
        brand: result.brand, 
        website: result.website, 
        industry: result.industry || "", 
        competitors: compStr 
      });
      saveScan(newResult);
      setResult(newResult);
      setScanError(null);
      
      // refresh history
      fetchScanHistory(result.brand).then(scans => {
        setHistory(scans || []);
      });
    } catch (e) {
      console.error("Re-run failed:", e);
      setScanError(e.message || "Failed to run scan. Please try again.");
    } finally {
      setIsScanning(false);
    }
  };



  return (
    <div className="min-h-screen bg-[#FDFBF7] relative print:bg-white">
      {/* Scanning Overlay */}
      {isScanning && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm transition-opacity duration-300">
          <Loader2 className="w-12 h-12 text-[#D9531E] animate-spin mb-4" />
          <h2 className="font-serif text-2xl font-semibold text-[#1A1A1A]">Scanning Answer Engines</h2>
          <p className="text-[#666666] mt-2">Running live prompts and analyzing AI responses...</p>
        </div>
      )}

      <Navbar />
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-10 md:py-14" data-testid="dashboard">
        {scanError && (
          <div className="mb-6 p-4 bg-[#F9ECEC] border border-[#E2B8B8] rounded-sm text-[#8B3A3A] text-sm flex items-center justify-between">
            <span>{scanError}</span>
            <button onClick={() => setScanError(null)} className="text-[#8B3A3A] font-semibold hover:underline">Dismiss</button>
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
              Visibility report
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
                Last scan {formatTimestamp(result.scanTimestamp)} ({relativeTime(result.scanTimestamp)})
              </span>
              {result.usedDynamicPrompts !== undefined && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#E8F0ED] text-[#2F5C4F] border border-[#B4D4CA] ml-1 align-middle">
                  {result.usedDynamicPrompts ? "dynamic prompts" : "static fallback"}
                </span>
              )}
              {!!result.tokensUsed && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#FDF6E3] text-[#8F6614] border border-[#E6D5A7] ml-1 align-middle">
                  ~{result.tokensUsed.toLocaleString()} tokens
                </span>
              )}
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
              className={`group inline-flex items-center gap-2 bg-transparent border transition-colors rounded-sm px-6 py-3 font-sans font-semibold text-xs uppercase tracking-[0.1em] ${isScanning ? "text-[#999999] border-[#E5E2D9] cursor-not-allowed" : "text-[#1A1A1A] border-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white"}`}
            >
              <RefreshCw className={`w-4 h-4 ${isScanning ? "animate-spin" : "group-hover:rotate-180 transition-transform duration-500"}`} strokeWidth={1.5} />
              {isScanning ? "Scanning..." : "Re-run"}
            </button>
          </div>
        </div>

        {/* KPI row — hero score + two supporting */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5 mb-8">
          <div className="lg:col-span-2">
            <HeroScoreCard
              testId="kpi-visibility-score"
              score={result.visibilityScore}
              tierText={tierLabel(tier)}
              trend={scoreTrend}
              isMixedTrend={isMixedTrend}
              promptSetChanged={promptSetChanged}
              mentionRate={result.mentionRatePct}
              scoreCiLow={result.scoreCiLow}
              scoreCiHigh={result.scoreCiHigh}
              historyScores={sortedHistory
                .filter(s => {
                  const ver = s.scoring_version ?? s.raw_results?.scoring_version ?? "v1-binary";
                  if (result.scoringVersion === "v1-binary") {
                    return ver === "v1-binary";
                  }
                  return ver !== "v1-binary";
                })
                .map(s => s.visibility_pct || 0)}
            />
          </div>
          <KpiCard
            testId="kpi-prompts"
            label="Prompts Analyzed"
            value={result.promptsAnalyzed}
            sub="Across your category"
            index={1}
          />
          <KpiCard
            testId="kpi-competitors"
            label="Competitors Found"
            value={result.competitorsFound}
            sub="Co-mentioned in answers"
            index={2}
          />
          <KpiCard
            testId="kpi-citations"
            label="Citations Extracted"
            value={result.totalCitations || 0}
            sub="URLs in AI responses"
            index={3}
          />
        </div>

        {/* Intent Breakdown Row (Phase 3) */}
        {result.intentBreakdown && (
          <div className="mb-8">
            <ScoreBreakdown breakdown={result.intentBreakdown} />
          </div>
        )}

        {/* History Row */}
        {sortedHistory.length > 1 && (
          <div className="mb-8 p-5 bg-white border border-[#E5E2D9] rounded-sm">
            <h3 className="text-xs font-semibold text-[#1A1A1A] mb-4 uppercase tracking-[0.1em]">Previous Scans</h3>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {sortedHistory.map((scan, i) => {
                const isActive = new Date(scan.scanned_at).getTime() === new Date(result.scanTimestamp).getTime();
                // Simple consecutive delta for the list (newer minus this one)
                const next = sortedHistory[i - 1];
                const cardDelta = next ? (next.visibility_pct - (scan.visibility_pct || 0)).toFixed(1) : null;
                return (
                  <button 
                    key={i} 
                    onClick={() => handleHistoryClick(scan)}
                    className={`min-w-[140px] text-left p-4 border rounded-sm transition-colors ${isActive ? "border-[#D9531E] bg-[#FFF8F5]" : "border-[#E5E2D9] bg-[#FDFBF7] hover:border-[#1A1A1A]"}`}
                  >
                    <div className="text-xs text-[#666666] whitespace-nowrap">{formatTimestamp(scan.scanned_at)}</div>
                    <div className="text-xl font-serif font-bold text-[#D9531E] mt-2">{scan.visibility_pct}%</div>
                    {cardDelta !== null && (
                      <div className={`text-[10px] mt-0.5 font-semibold ${parseFloat(cardDelta) > 0 ? "text-[#2F5C4F]" : parseFloat(cardDelta) < 0 ? "text-[#8B3A3A]" : "text-[#999999]"}`}>
                        {parseFloat(cardDelta) > 0 ? "+" : ""}{cardDelta}%
                      </div>
                    )}
                    <div className="text-xs text-[#999999] mt-1">{scan.prompts_tracked} prompts</div>
                    {scan.used_dynamic_prompts !== undefined && (
                      <div className="text-[10px] mt-1 text-[#2F5C4F]">{scan.used_dynamic_prompts ? "dyn" : "static"}</div>
                    )}
                    {(scan.scoring_version !== undefined || scan.raw_results?.scoring_version !== undefined) && (
                      <div className="text-[10px] mt-1 text-[#666666] italic">
                        {scan.scoring_version ?? scan.raw_results?.scoring_version ?? "v1-binary"}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-6 border-b border-[#E5E2D9] mb-8 overflow-x-auto pb-px print:hidden">
          {["overview", "queries", "opportunities", "citations"].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-4 text-sm font-semibold uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab 
                  ? "border-[#1A1A1A] text-[#1A1A1A]" 
                  : "border-transparent text-[#999999] hover:text-[#1A1A1A]"
              }`}
            >
              {tab === "citations" ? "Citations & Sources" : tab === "queries" ? "Tracked Queries" : tab}
            </button>
          ))}
        </div>

        {/* Main Content Area */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              <TopPromptsTable prompts={topPromptsWithTrend} />
              <CompetitorTable competitors={competitorsWithTrend} />
            </div>
            <div className="lg:col-span-1">
              <div className="lg:sticky lg:top-24">
                <InsightPanel result={resultWithFlags} trend={scoreTrend} onRerun={handleRerun} />
              </div>
            </div>
          </div>
        )}

        {activeTab === "queries" && (
          <QueryManager brand={result.brand} currentPrompts={result.topPrompts} />
        )}

        {activeTab === "opportunities" && (
          <OpportunitiesPanel result={result} />
        )}

        {activeTab === "citations" && (
          <CitationsPanel result={result} />
        )}
      </div>
    </div>
  );
}
