"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, FlaskConical } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { KpiCard, HeroScoreCard } from "@/components/dashboard/KpiCard";
import { TopPromptsTable } from "@/components/dashboard/TopPromptsTable";
import { CompetitorTable } from "@/components/dashboard/CompetitorTable";
import { InsightPanel } from "@/components/dashboard/InsightPanel";
import { OpportunitiesPanel } from "@/components/dashboard/OpportunitiesPanel";
import { CitationsPanel } from "@/components/dashboard/CitationsPanel";
import { loadScan, fetchScanHistory, normalizeResult } from "@/services/api";
import { scoreTier, tierLabel, formatTimestamp, relativeTime } from "@/utils/format";

export default function Dashboard() {
  const router = useRouter();
  const [result, setResult] = useState(undefined);
  const [history, setHistory] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
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

  const { scoreTrend, previousScan, sortedHistory, topPromptsWithTrend, competitorsWithTrend } = React.useMemo(() => {
    let scoreTrend = null;
    let previousScan = null;
    let sortedHistory = [];
    let topPromptsWithTrend = [];
    let competitorsWithTrend = [];

    if (!result) return { scoreTrend, previousScan, sortedHistory, topPromptsWithTrend, competitorsWithTrend };

    if (history && history.length > 0) {
      sortedHistory = [...history].sort((a,b) => new Date(b.scanned_at) - new Date(a.scanned_at));
      const idx = sortedHistory.findIndex(s => new Date(s.scanned_at).getTime() === new Date(result.scanTimestamp).getTime());
      if (idx !== -1 && idx + 1 < sortedHistory.length) {
        const prev = sortedHistory[idx + 1];
        scoreTrend = (result.visibilityScore - (prev.visibility_pct || 0)).toFixed(1);
        previousScan = normalizeResult(prev, result.brand, result.website);
      } else if (idx === -1 && sortedHistory.length > 0) {
        // result not in history yet
        scoreTrend = (result.visibilityScore - (sortedHistory[0].visibility_pct || 0)).toFixed(1);
        previousScan = normalizeResult(sortedHistory[0], result.brand, result.website);
      }
    }

    topPromptsWithTrend = (result.topPrompts || []).map(p => {
      if (previousScan && previousScan.topPrompts) {
        const prevP = previousScan.topPrompts.find(pp => pp.prompt.toLowerCase() === p.prompt.toLowerCase());
        const currRank = typeof p.rank === "number" ? p.rank : null;
        const prevRank = prevP && typeof prevP.rank === "number" ? prevP.rank : null;
        if (prevRank !== null && currRank !== null) {
          return { ...p, trend: prevRank - currRank };
        }
      }
      return p;
    });

    competitorsWithTrend = (result.competitors || []).map(c => {
      if (previousScan && previousScan.competitors) {
        const prevC = previousScan.competitors.find(pc => pc.name.toLowerCase() === c.name.toLowerCase());
        const currVis = typeof c.visibilityScore === "number" ? c.visibilityScore : 0;
        const prevVis = prevC && typeof prevC.visibilityScore === "number" ? prevC.visibilityScore : 0;
        if (prevC) {
          return { ...c, trend: (currVis - prevVis).toFixed(1) };
        }
      }
      return c;
    });

    return { scoreTrend, previousScan, sortedHistory, topPromptsWithTrend, competitorsWithTrend };
  }, [result, history]);

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
      </div>
    );
  }

  const tier = scoreTier(result.visibilityScore);

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
      
      // refresh history
      fetchScanHistory(result.brand).then(scans => {
        setHistory(scans || []);
      });
    } catch (e) {
      console.error("Re-run failed:", e);
    } finally {
      setIsScanning(false);
    }
  };



  return (
    <div className="min-h-screen bg-[#FDFBF7]">
      <Navbar />
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-10 md:py-14" data-testid="dashboard">
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
            </div>
          </div>
          <button
            data-testid="rerun-scan-btn"
            onClick={handleRerun}
            disabled={isScanning}
            className={`group inline-flex items-center gap-2 self-start md:self-auto bg-transparent border transition-colors rounded-sm px-6 py-3 font-sans font-semibold text-xs uppercase tracking-[0.1em] ${isScanning ? "text-[#999999] border-[#E5E2D9] cursor-not-allowed" : "text-[#1A1A1A] border-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white"}`}
          >
            <RefreshCw className={`w-4 h-4 ${isScanning ? "animate-spin" : "group-hover:rotate-180 transition-transform duration-500"}`} strokeWidth={1.5} />
            {isScanning ? "Scanning..." : "Re-run scan"}
          </button>
        </div>

        {/* KPI row — hero score + two supporting */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5 mb-8">
          <div className="lg:col-span-2">
            <HeroScoreCard
              testId="kpi-visibility-score"
              score={result.visibilityScore}
              tierText={tierLabel(tier)}
              trend={scoreTrend}
              historyScores={sortedHistory.map(s => s.visibility_pct || 0)}
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
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-6 border-b border-[#E5E2D9] mb-8 overflow-x-auto pb-px">
          {["overview", "opportunities", "citations"].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-4 text-sm font-semibold uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab 
                  ? "border-[#1A1A1A] text-[#1A1A1A]" 
                  : "border-transparent text-[#999999] hover:text-[#1A1A1A]"
              }`}
            >
              {tab === "citations" ? "Citations & Sources" : tab}
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
                <InsightPanel result={result} trend={scoreTrend} onRerun={handleRerun} />
              </div>
            </div>
          </div>
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
