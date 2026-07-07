import React from "react";

export const CompetitorTable = ({ competitors = [], results = [], brandMentions = 0 }) => {
  // Calculate total mentions across brand + all competitors
  const totalCompetitorMentions = competitors.reduce((sum, c) => sum + (c.mentions || 0), 0);
  const totalMentions = brandMentions + totalCompetitorMentions;

  // Filter comparison prompts
  const comparisonPrompts = results.filter(
    r => r.intentTier === "comparison" || r.intent_tier === "comparison"
  );
  const totalComparison = comparisonPrompts.length;

  return (
    <div
      data-testid="competitor-table"
      className="bg-white border border-[#E5E2D9] rounded-sm"
    >
      <div className="px-7 py-6 flex items-end justify-between">
        <div>
          <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">
            Competitor Share of Voice & Performance
          </h3>
          <p className="text-sm text-[#666666] mt-1">
            Rival presence, share of voice, and direct comparison performance (win rate is % where they appear and you are absent)
          </p>
        </div>
        <span className="text-xs uppercase tracking-[0.15em] text-[#999999] font-medium">
          {competitors.length} found
        </span>
      </div>

      {competitors.length === 0 ? (
        <div className="px-7 py-14 text-center text-[#999999] text-sm border-t border-[#E5E2D9]" data-testid="competitor-empty">
          No competitor mentions found in this scan.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold px-7 py-3">
                  Competitor
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-28">
                  Visibility
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-32">
                  Share of Voice
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-36">
                  Comparison Win Rate
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-right px-7 py-3 w-32">
                  Gap
                </th>
              </tr>
            </thead>
            <tbody>
              {competitors.map((c, i) => {
                // Share of Voice
                const sov = totalMentions > 0 ? Math.round((c.mentions / totalMentions) * 1000) / 10 : 0.0;

                // Win rate for this competitor: mentioned in comparison prompt where brand is not mentioned
                let compWins = 0;
                comparisonPrompts.forEach(r => {
                  const compFound = (r.competitorsFound || r.competitors_found || []).some(
                    name => name.toLowerCase() === c.name.toLowerCase()
                  );
                  if (compFound && !r.mentioned) {
                    compWins++;
                  }
                });
                const winRate = totalComparison > 0 ? Math.round((compWins / totalComparison) * 1000) / 10 : 0.0;

                return (
                  <tr
                    key={i}
                    data-testid={`competitor-row-${i}`}
                    className="border-b border-[#E5E2D9] last:border-0 hover:bg-[#FDFBF7] transition-colors"
                  >
                    <td className="px-7 py-5">
                      <div className="text-sm font-semibold text-[#1A1A1A] capitalize">{c.name}</div>
                      <div className="text-xs text-[#999999] mt-0.5">
                        {c.mentions} mention{c.mentions === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="px-4 py-5 text-center">
                      <div className="flex flex-col items-center justify-center gap-1">
                        <span className="font-serif font-semibold text-xl text-[#1A1A1A]">
                          {c.visibilityScore !== undefined ? `${c.visibilityScore}%` : c.mentions}
                        </span>
                        {c.trend !== undefined && parseFloat(c.trend) !== 0 && (
                          <span className={`text-[10px] px-1 py-0.5 rounded-sm font-semibold ${parseFloat(c.trend) > 0 ? "bg-[#E8F0ED] text-[#2F5C4F]" : "bg-[#F9ECEC] text-[#8B3A3A]"}`}>
                            {parseFloat(c.trend) > 0 ? "↑" : "↓"}{Math.abs(parseFloat(c.trend))}%
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-5 text-center font-serif text-lg font-medium text-[#1A1A1A]">
                      {sov}%
                    </td>
                    <td className="px-4 py-5 text-center font-serif text-lg font-medium text-[#1A1A1A]">
                      {winRate}%
                    </td>
                    <td className="px-7 py-5 text-right">
                      {c.userAbsent ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[11px] font-semibold border uppercase tracking-[0.1em] bg-[#F9ECEC] text-[#8B3A3A] border-[#E2B8B8]">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#8B3A3A]" />
                          You absent
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[11px] font-semibold border uppercase tracking-[0.1em] bg-[#E8F0ED] text-[#2F5C4F] border-[#B4D4CA]">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#2F5C4F]" />
                          Co-present
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
