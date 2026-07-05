import { ArrowUpRight } from "lucide-react";
import { scoreTier, tierLabel } from "@/utils/format";
import { ScoreBadge } from "@/components/ScoreBadge";

export const InsightPanel = ({ result, trend, onRerun }) => {
  const tier = scoreTier(result.visibilityScore);
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
