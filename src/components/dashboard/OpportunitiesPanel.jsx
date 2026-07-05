import { useState, useEffect } from "react";
import { Lightbulb, Target, Loader2 } from "lucide-react";

export const OpportunitiesPanel = ({ result }) => {
  const [insights, setInsights] = useState([]);
  const [loading, setLoading] = useState(true);

  const prompts = result.rawResults || result.topPrompts || [];
  
  // Filter for gaps (brand not mentioned / omitted)
  const gaps = prompts.filter(p => p.mentioned === false || p.position === "omitted");
  
  // Sort gaps by volume if available, or just prioritize ones with competitors
  const volScore = (vol) => {
    if (typeof vol === 'string') {
      const v = vol.toLowerCase();
      if (v === 'high') return 30;
      if (v === 'medium') return 20;
      if (v === 'low') return 10;
    }
    return 0;
  };

  const sortedGaps = [...gaps].map(g => {
    const vScore = volScore(g.volume || g.sentiment);
    const compScore = (g.competitorsFound || g.competitors_found || []).length * 15;
    // Base 20 for being a gap at all
    const potential = Math.min(100, 20 + vScore + compScore);
    return { ...g, potential };
  }).sort((a, b) => b.potential - a.potential).slice(0, 5); // Top 5 opportunities

  useEffect(() => {
    if (sortedGaps.length === 0) {
      setLoading(false);
      return;
    }

    const fetchInsights = async () => {
      try {
        const res = await fetch("/api/opportunities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gaps: sortedGaps, brand: result.brand })
        });
        if (res.ok) {
          const data = await res.json();
          setInsights(data.recommendations || []);
        }
      } catch (e) {
        console.error("Failed to fetch LLM insights", e);
      } finally {
        setLoading(false);
      }
    };

    fetchInsights();
  }, [result.brand]); // re-run only if brand changes (or use stringified gaps if needed, but it's safe enough for dashboard)

  if (sortedGaps.length === 0) {
    return (
      <div className="bg-white border border-[#E5E2D9] rounded-sm p-12 text-center">
        <p className="text-[#999999] text-sm">No major gaps identified. Your visibility is excellent.</p>
      </div>
    );
  }

  const getRecommendation = (p, idx) => {
    if (insights[idx]) return insights[idx];
    
    // Fallback heuristic if LLM fails
    const comps = p.competitorsFound || p.competitors_found || [];
    if (comps.length > 0) {
      return `Create or optimize a comparison page targeting "${result.brand} vs ${comps[0]}".`;
    }
    return `Publish dedicated content answering this exact prompt to capture intent.`;
  };

  return (
    <div data-testid="opportunities-panel" className="bg-white border border-[#E5E2D9] rounded-sm">
      <div className="px-7 py-6 border-b border-[#E5E2D9]">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-[#D9531E]" />
          <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">
            Actionable Opportunities
          </h3>
        </div>
        <p className="text-sm text-[#666666] mt-1">
          High-value prompts where your brand is currently invisible.
        </p>
      </div>
      <div className="divide-y divide-[#E5E2D9] relative">
        {loading && (
          <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center backdrop-blur-[1px]">
            <Loader2 className="w-8 h-8 text-[#D9531E] animate-spin" />
          </div>
        )}
        {sortedGaps.map((p, i) => (
          <div key={i} className="p-7 flex flex-col md:flex-row gap-6 items-start md:items-center justify-between hover:bg-[#FDFBF7] transition-colors">
            <div className="flex-1">
              <div className="text-sm font-semibold text-[#1A1A1A]">{p.prompt}</div>
              <div className="mt-2 text-xs text-[#666666] flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-[#1A1A1A]">
                  Potential Score: <span className="text-[#D9531E] font-serif text-base">{p.potential}</span>/100
                </span>
                {(p.competitorsFound || p.competitors_found)?.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-[#8B3A3A]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#8B3A3A]" />
                    Competitors: {(p.competitorsFound || p.competitors_found).join(", ")}
                  </span>
                )}
                <span className="uppercase tracking-wider text-[10px] font-medium px-2 py-0.5 bg-[#F3F0E6] rounded-sm">
                  {p.volume || p.sentiment || "Unknown"} Volume
                </span>
              </div>
            </div>
            <div className="bg-[#FFF8F5] border border-[#E2B8B8] rounded-sm p-4 md:w-2/5 shrink-0">
              <div className="flex items-start gap-2">
                <Target className="w-4 h-4 text-[#D9531E] shrink-0 mt-0.5" />
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[#D9531E] font-semibold mb-1">AI Recommendation</div>
                  <div className="text-xs text-[#1A1A1A] leading-relaxed">
                    {getRecommendation(p, i)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
