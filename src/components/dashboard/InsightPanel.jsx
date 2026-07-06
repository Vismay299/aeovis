import { ArrowUpRight } from "lucide-react";
import { scoreTier, tierLabel } from "@/utils/format";
import { ScoreBadge } from "@/components/ScoreBadge";

export const InsightPanel = ({ result, trend, onRerun }) => {
  const tier = scoreTier(result.visibilityScore, result.scoringVersion);
  const interpretation = {
    strong:
      "Your brand holds strong answer-engine presence. Defend the lead by monitoring high-intent comparison prompts where rivals push hardest.",
    moderate:
      "You appear in many answers but lose ground on comparison and pricing prompts. There is clear, addressable room to grow.",
    weak:
      "Your brand is largely invisible in AI answers. Competitors are capturing the exact queries your buyers ask.",
  }[tier];

  return (
    <div
      data-testid="insight-panel"
      className="bg-[#F3F0E6] border border-[#E5E2D9] rounded-sm p-7 md:p-8"
    >
      <span className="text-xs uppercase tracking-[0.15em] text-[#666666] font-medium">
        Summary Insights
      </span>
      <h3 className="font-serif text-3xl font-semibold text-[#1A1A1A] leading-tight mt-2">
        What this means
      </h3>

      <div className="flex items-center gap-3 mt-5">
        <ScoreBadge tier={tier} testId="insight-score-badge" />
        <span className="text-sm text-[#666666]">
          {tierLabel(tier)} at <span className="text-[#1A1A1A] font-semibold">{result.visibilityScore}/100</span>
          {trend !== null && trend !== undefined && (
            <span className={`ml-2 text-xs font-semibold ${parseFloat(trend) > 0 ? "text-[#2F5C4F]" : parseFloat(trend) < 0 ? "text-[#8B3A3A]" : "text-[#999999]"}`}>
              ({parseFloat(trend) > 0 ? "+" : ""}{trend})
            </span>
          )}
        </span>
      </div>

      <p className="text-[15px] text-[#1A1A1A] leading-relaxed mt-4" data-testid="insight-interpretation">
        {interpretation}
      </p>

      {(() => {
        const topicEntries = Object.entries(result.topicScores || {});
        if (topicEntries.length === 0) return null;
        const sorted = [...topicEntries].sort((a, b) => b[1] - a[1]);
        const strongest = sorted[0];
        const weakest = sorted[sorted.length - 1];

        return (
          <div className="mt-5 p-4 bg-white/60 border border-[#E5E2D9] rounded-sm text-xs text-[#1A1A1A]">
            <h4 className="font-bold text-[10px] uppercase tracking-wider text-[#666666] mb-2">Topic Performance</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <span className="text-[#666666]">Strongest Area:</span>
                <div className="font-serif font-bold text-sm text-[#2F5C4F] mt-0.5">
                  {strongest[0]} ({strongest[1]}%)
                </div>
              </div>
              {strongest[0] !== weakest[0] && (
                <div>
                  <span className="text-[#666666]">Weakest Area:</span>
                  <div className="font-serif font-bold text-sm text-[#8B3A3A] mt-0.5">
                    {weakest[0]} ({weakest[1]}%)
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {result.stability === "volatile" && (
        <div className="mt-4 p-3.5 bg-[#F9ECEC] border border-[#E2B8B8] rounded-sm text-xs text-[#8B3A3A] font-medium flex items-center gap-2">
          <span>⚠️</span>
          <span><strong>Volatile Scan:</strong> Score may vary due to high answer variance. Consider re-running to get a more stable estimate.</span>
        </div>
      )}

      {result.stability === "medium" && (
        <div className="mt-4 p-3.5 bg-[#FDF6E3] border border-[#E6D5A7] rounded-sm text-xs text-[#8F6614] font-medium flex items-center gap-2">
          <span>ℹ️</span>
          <span><strong>Moderate Variance:</strong> Some fluctuation in AI responses detected. Score is stable but could vary slightly between runs.</span>
        </div>
      )}

      {result.promptSetChanged && (
        <div className="mt-4 p-3.5 bg-[#FDF6E3] border border-[#E6D5A7] rounded-sm text-xs text-[#8F6614] font-medium flex items-center gap-2">
          <span>⚠️</span>
          <span><strong>Prompt Set Changed:</strong> The tracked queries changed since the last scan. Historical trend comparisons may be less accurate.</span>
        </div>
      )}

      {result.summary && (
        <p className="text-sm text-[#666666] leading-relaxed border-l-2 border-[#D9531E] pl-4 mt-5 italic font-serif text-base">
          {result.summary}
        </p>
      )}

      <div className="mt-7 pt-6 border-t border-[#E5E2D9]">
        <span className="text-xs uppercase tracking-[0.15em] text-[#666666] font-medium">
          Recommended next step
        </span>
        <button
          data-testid="insight-next-step"
          onClick={onRerun}
          className="group mt-3 w-full flex items-center justify-between gap-3 bg-white hover:bg-[#1A1A1A] border border-[#1A1A1A] rounded-sm px-5 py-4 transition-colors text-left"
        >
          <span className="text-sm font-semibold text-[#1A1A1A] group-hover:text-white transition-colors">
            Re-run with refined prompts to close gaps
          </span>
          <ArrowUpRight
            className="w-5 h-5 text-[#1A1A1A] group-hover:text-white transition-colors shrink-0"
            strokeWidth={1.5}
          />
        </button>
      </div>
    </div>
  );
};
