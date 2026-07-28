import { useState, useEffect } from "react";
import { Lightbulb, Target, Loader2 } from "lucide-react";

export const OpportunitiesPanel = ({ result }) => {
  const [insights, setInsights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const prompts = result.rawResults || result.topPrompts || [];
  
  // Filter for gaps (where competitor is visible but brand is not, i.e., gapScore > 0 or omitted)
  const gaps = prompts.filter(p => (p.gapScore !== undefined ? p.gapScore > 0 : (p.mentioned === false || p.position === "omitted")));
  
  const sortedGaps = [...gaps].map(g => {
    const potential = g.gapScore !== undefined ? Math.round(g.gapScore) : 50;
    return { ...g, potential };
  }).sort((a, b) => {
    const gapA = a.gapScore !== undefined ? a.gapScore : 0;
    const gapB = b.gapScore !== undefined ? b.gapScore : 0;
    return gapB - gapA;
  }).slice(0, 5); // Top 5 opportunities by gapScore

  useEffect(() => {
    if (sortedGaps.length === 0) {
      setLoading(false);
      return;
    }

    const fetchInsights = async () => {
      setLoading(true);
      setHasError(false);
      try {
        const res = await fetch("/api/opportunities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gaps: sortedGaps, brand: result.brand })
        });
        if (res.ok) {
          const data = await res.json();
          setInsights(data.recommendations || []);
        } else {
          setHasError(true);
        }
      } catch (e) {
        console.error("Failed to fetch LLM insights", e);
        setHasError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchInsights();
  }, [result.brand, JSON.stringify(sortedGaps)]); // re-run only if brand or exact gaps change

  if (sortedGaps.length === 0) {
    return (
      <div className="bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm p-12 text-center">
        <p className="text-[var(--text-3)] text-sm">No major gaps identified. Your visibility is excellent.</p>
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
    <div data-testid="opportunities-panel" className="bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm">
      <div className="px-7 py-6 border-b border-[var(--rule-1)]">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-[var(--lamp-amber)]" />
          <h3 className="font-serif text-2xl font-semibold text-[var(--text-1)] leading-tight">
            Actionable Opportunities
          </h3>
        </div>
        <p className="text-sm text-[var(--text-2)] mt-1">
          High-value prompts where your brand is currently invisible.
        </p>
      </div>
      <div className="divide-y divide-[var(--rule-1)] relative">
        {loading && (
          <div className="absolute inset-0 bg-[var(--panel-1)]/60 z-10 flex items-center justify-center backdrop-blur-[1px]">
            <Loader2 className="w-8 h-8 text-[var(--lamp-amber)] animate-spin" />
          </div>
        )}
        {sortedGaps.map((p, i) => (
          <div key={i} className="p-7 flex flex-col md:flex-row gap-6 items-start md:items-center justify-between hover:bg-[var(--panel-1)] transition-colors">
            <div className="flex-1">
              <div className="text-sm font-semibold text-[var(--text-1)]">{p.prompt}</div>
              <div className="mt-2 text-xs text-[var(--text-2)] flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-1)]">
                  Potential Score: <span className="text-[var(--lamp-amber)] font-serif text-base">{p.potential}</span>/100
                </span>
                {(p.competitorsFound || p.competitors_found)?.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-[var(--lamp-red)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--lamp-red)]" />
                    Competitors: {(p.competitorsFound || p.competitors_found).join(", ")}
                  </span>
                )}
                <span className="uppercase tracking-wider text-[10px] font-medium px-2 py-0.5 bg-[var(--panel-2)] rounded-sm">
                  {p.volume || p.sentiment || "Unknown"} Volume
                </span>
              </div>
            </div>
            <div className="bg-[var(--lamp-red-soft)] border border-[var(--lamp-red-edge)] rounded-sm p-4 md:w-2/5 shrink-0">
              <div className="flex items-start gap-2">
                <Target className="w-4 h-4 text-[var(--lamp-amber)] shrink-0 mt-0.5" />
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--lamp-amber)] font-semibold mb-1">AI Recommendation</div>
                  <div className="text-xs text-[var(--text-1)] leading-relaxed">
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
