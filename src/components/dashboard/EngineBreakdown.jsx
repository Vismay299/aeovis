import React from "react";
import { Cpu, ShieldAlert, BadgeDollarSign } from "lucide-react";

const ENGINE_CONFIGS = {
  google_ai_overview: {
    label: "Google AI Overview",
    color: "bg-gradient-to-r from-[#4285F4] via-[#EA4335] via-[#FBBC05] to-[#34A853]",
    textColor: "text-[#4285F4]",
    badgeBg: "bg-[#e8f0fe]",
    defaultWeight: 0.50
  },
  perplexity: {
    label: "Perplexity",
    color: "bg-gradient-to-r from-[#208080] to-[#3a9f9f]",
    textColor: "text-[#208080]",
    badgeBg: "bg-[#eef8f8]",
    defaultWeight: 0.25
  },
  openai: {
    label: "ChatGPT (GPT-4o)",
    color: "bg-gradient-to-r from-[#10a37f] to-[#22c55e]",
    textColor: "text-[#10a37f]",
    badgeBg: "bg-[#eafaf5]",
    defaultWeight: 0.15
  },
  gemini: {
    label: "Gemini",
    color: "bg-gradient-to-r from-[#4b39ef] to-[#827ae6]",
    textColor: "text-[#4b39ef]",
    badgeBg: "bg-[#eef2ff]",
    defaultWeight: 0.10
  }
};

export const EngineBreakdown = ({ result }) => {
  const engineScores = result.engineScores || {};
  const costByEngine = result.costByEngine || {};
  const enginesPartial = result.enginesPartial || false;
  const serpCoveragePct = result.serpCoveragePct;

  const displayOrder = ["google_ai_overview", "perplexity", "openai", "gemini"];
  const enginesToShow = Object.keys(engineScores).length > 0
    ? Object.keys(engineScores).sort((a, b) => displayOrder.indexOf(a) - displayOrder.indexOf(b))
    : ["gemini"];

  // Normalize weights for active engines
  let totalWeight = 0;
  enginesToShow.forEach(eng => {
    totalWeight += ENGINE_CONFIGS[eng]?.defaultWeight ?? 0.25;
  });
  if (totalWeight === 0) totalWeight = 1.0;

  const normalizedWeights = {};
  enginesToShow.forEach(eng => {
    normalizedWeights[eng] = ((ENGINE_CONFIGS[eng]?.defaultWeight ?? 0.25) / totalWeight) * 100;
  });

  return (
    <div
      data-testid="engine-breakdown"
      className="bg-white border border-[#E5E2D9] rounded-sm p-6"
    >
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-serif text-xl font-semibold text-[#1A1A1A]">
            Engine-Specific Visibility
          </h3>
          <p className="text-xs text-[#666666] mt-0.5">
            Performance across key search and LLM platforms
          </p>
        </div>
        {enginesPartial && (
          <span className="flex items-center gap-1 text-[10px] uppercase font-bold text-[#8B3A3A] bg-[#F9ECEC] px-2 py-0.5 rounded-sm">
            <ShieldAlert className="w-3.5 h-3.5" />
            Partial Output
          </span>
        )}
      </div>

      <div className="space-y-5">
        {enginesToShow.map(eng => {
          const config = ENGINE_CONFIGS[eng] || {
            label: eng.toUpperCase(),
            color: "bg-gradient-to-r from-[#999999] to-[#cccccc]",
            textColor: "text-[#666666]",
            badgeBg: "bg-[#f2f2f2]"
          };

          const score = engineScores[eng] !== undefined ? engineScores[eng] : 0.0;
          const cost = costByEngine[eng] !== undefined ? costByEngine[eng] : 0.0;
          const weight = Math.round(normalizedWeights[eng] ?? 0);

          return (
            <div key={eng} className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className={`font-semibold ${config.textColor}`}>{config.label}</span>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${config.badgeBg} ${config.textColor}`}>
                    Weight: {weight}%
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  {cost > 0 && (
                    <span className="text-xs text-[#666666] flex items-center gap-1" title="Estimated query API costs">
                      <BadgeDollarSign className="w-3.5 h-3.5 text-[#2F5C4F]" />
                      ${cost.toFixed(4)}
                    </span>
                  )}
                  <span className="font-serif font-bold text-base text-[#1A1A1A]">
                    {score.toFixed(1)}%
                  </span>
                </div>
              </div>
              <div className="h-2 w-full bg-[#E5E2D9] rounded-full overflow-hidden relative">
                <div
                  className={`h-full ${config.color} rounded-full transition-all duration-500`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {serpCoveragePct != null && enginesToShow.includes("google_ai_overview") && (
        <div className="mt-4 pt-3 border-t border-[#E5E2D9] flex items-center justify-between text-xs text-[#666666]">
          <span>AI Overview Coverage Rate</span>
          <span className="font-semibold text-[#1A1A1A]">{serpCoveragePct.toFixed(1)}%</span>
        </div>
      )}

      <div className="mt-5 pt-4 border-t border-[#E5E2D9] flex items-center gap-1.5 text-[11px] text-[#999999]">
        <Cpu className="w-3.5 h-3.5 text-[#D9531E]" />
        <span>Headline visibility is a weighted blend of engine visibility scores.</span>
      </div>
    </div>
  );
};
