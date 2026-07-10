import React from "react";

export const CompetitorTable = ({ competitors = [], results = [] }) => {
  const nonBrandedAioCount = (results || []).filter(
    (r) => !r.is_branded_query && r.aio_present
  ).length;

  return (
    <div
      data-testid="competitor-table"
      className="bg-white border border-[#E5E2D9] rounded-sm"
    >
      <div className="px-7 py-6 flex items-end justify-between">
        <div>
          <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">
            Competitor share of AI Overview
          </h3>
          <p className="text-sm text-[#666666] mt-1">
            How often each rival appears in the {nonBrandedAioCount} non-branded AI Overviews.
          </p>
        </div>
        <span className="text-xs uppercase tracking-[0.15em] text-[#999999] font-medium">
          {competitors.length} tracked
        </span>
      </div>

      {competitors.length === 0 ? (
        <div
          className="px-7 py-14 text-center text-[#999999] text-sm border-t border-[#E5E2D9]"
          data-testid="competitor-empty"
        >
          No competitors were mentioned or cited in this scan.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold px-7 py-3">
                  Competitor
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-32">
                  AIO Visibility
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-32">
                  Citation Share
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-28">
                  Mentions
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-right px-7 py-3 w-32">
                  Gap
                </th>
              </tr>
            </thead>
            <tbody>
              {competitors.map((c, i) => (
                <tr
                  key={i}
                  data-testid={`competitor-row-${i}`}
                  className="border-b border-[#E5E2D9] last:border-0 hover:bg-[#FDFBF7] transition-colors"
                >
                  <td className="px-7 py-5">
                    <div className="text-sm font-semibold text-[#1A1A1A] capitalize">
                      {c.name}
                    </div>
                    <div className="text-xs text-[#999999] mt-0.5">
                      {c.prompts || 0} AIO appearance
                      {(c.prompts || 0) === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="px-4 py-5 text-center">
                    <span className="font-serif font-semibold text-xl text-[#1A1A1A]">
                      {c.visibilityScore ?? 0}%
                    </span>
                  </td>
                  <td className="px-4 py-5 text-center font-serif text-lg font-medium text-[#1A1A1A]">
                    {c.citationShare ?? 0}%
                  </td>
                  <td className="px-4 py-5 text-center text-sm text-[#666666]">
                    <div className="font-semibold text-[#1A1A1A]">{c.mentions ?? 0} text</div>
                    <div className="text-xs">{c.citations ?? 0} cited</div>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
