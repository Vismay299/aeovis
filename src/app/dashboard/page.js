"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, FlaskConical } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { KpiCard, HeroScoreCard } from "@/components/dashboard/KpiCard";
import { TopPromptsTable } from "@/components/dashboard/TopPromptsTable";
import { CompetitorTable } from "@/components/dashboard/CompetitorTable";
import { InsightPanel } from "@/components/dashboard/InsightPanel";
import { loadScan } from "@/services/api";
import { scoreTier, tierLabel, formatTimestamp, relativeTime } from "@/utils/format";

export default function Dashboard() {
  const router = useRouter();
  const [result, setResult] = useState(undefined);

  useEffect(() => {
    setResult(loadScan());
  }, []);

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
            </div>
          </div>
          <button
            data-testid="rerun-scan-btn"
            onClick={() => router.push("/scan")}
            className="group inline-flex items-center gap-2 self-start md:self-auto bg-transparent text-[#1A1A1A] border border-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-colors rounded-sm px-6 py-3 font-sans font-semibold text-xs uppercase tracking-[0.1em]"
          >
            <RefreshCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" strokeWidth={1.5} />
            Re-run scan
          </button>
        </div>

        {/* KPI row — hero score + two supporting */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          <div className="lg:col-span-2">
            <HeroScoreCard
              testId="kpi-visibility-score"
              score={result.visibilityScore}
              tierText={tierLabel(tier)}
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
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <TopPromptsTable prompts={result.topPrompts || []} />
            <CompetitorTable competitors={result.competitors || []} />
          </div>
          <div className="lg:col-span-1">
            <div className="lg:sticky lg:top-24">
              <InsightPanel result={result} onRerun={() => router.push("/scan")} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
