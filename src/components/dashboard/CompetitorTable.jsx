import React from "react";

function tierStyles(tier) {
  if (tier === "Top Tier") {
    return "bg-[#F3EEFF] text-[#5B3FA0] border-[#D4C8F5]";
  }
  if (tier === "Mid Tier") {
    return "bg-[#EBF3FF] text-[#4B6B94] border-[#BACEEA]";
  }
  if (tier === "Emerging") {
    return "bg-[#F3F0E6] text-[#666666] border-[#E5E2D9]";
  }
  return "bg-[#F5F5F5] text-[#666666] border-[#E5E2D9]";
}

export const CompetitorTable = ({
  competitors = [],
  results = [],
  competitorsConfigured,
}) => {
  const nonBrandedAioCount = (results || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery) &&
      !!(r.aio_present ?? r.aioPresent)
  ).length;

  const withSignal = (competitors || []).filter(
    (c) =>
      (c.visibilityScore ?? 0) > 0 ||
      (c.mentions ?? 0) > 0 ||
      (c.citations ?? 0) > 0
  );
  const displayList = withSignal.length > 0 ? withSignal : competitors;

  const configured =
    competitorsConfigured != null
      ? !!competitorsConfigured
      : displayList.length > 0;

  return (
    <div
      data-testid="competitor-table"
      className="bg-white border border-[#E5E2D9] rounded-sm"
    >
      <div className="px-7 py-6 flex items-end justify-between gap-4">
        <div>
          <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">
            Co-mention context
          </h3>
          <p className="text-sm text-[#666666] mt-1">
            Brands frequently mentioned or cited alongside yours in{" "}
            {nonBrandedAioCount} non-branded AI Overviews. Auto-discovered from
            AIO text and sources
            {displayList.some((c) => c.source === "user")
              ? ", plus any names you tracked"
              : ""}
            .
          </p>
        </div>
        <span className="text-xs uppercase tracking-[0.15em] text-[#999999] font-medium shrink-0">
          {displayList.length} competitor{displayList.length === 1 ? "" : "s"}
        </span>
      </div>

      {displayList.length === 0 ? (
        <div
          className="px-7 py-14 text-center text-[#999999] text-sm border-t border-[#E5E2D9]"
          data-testid="competitor-empty"
        >
          {configured
            ? "No rival brands were co-mentioned in the AI Overviews for this scan."
            : "No co-mentioned competitors found in AI Overviews yet. Re-run a scan to discover rivals from live answers."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold px-7 py-3">
                  Competitor
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-36">
                  Co-mention rate
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-32">
                  Citation share
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-28">
                  Mentions
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-right px-7 py-3 w-36">
                  Gap
                </th>
              </tr>
            </thead>
            <tbody>
              {displayList.map((c, i) => (
                <tr
                  key={`${c.name}-${i}`}
                  data-testid={`competitor-row-${i}`}
                  className="border-b border-[#E5E2D9] last:border-0 hover:bg-[#FDFBF7] transition-colors"
                >
                  <td className="px-7 py-5">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-[#F3F0E6] border border-[#E5E2D9] flex items-center justify-center text-xs font-bold text-[#1A1A1A] shrink-0">
                        {(c.name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-[#1A1A1A]">
                          {c.name}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {c.tier && (
                            <span
                              className={`inline-flex text-[10px] uppercase tracking-[0.1em] font-semibold px-1.5 py-0.5 rounded-sm border ${tierStyles(
                                c.tier
                              )}`}
                            >
                              {c.tier}
                            </span>
                          )}
                          {c.source === "discovered" && (
                            <span className="text-[10px] uppercase tracking-[0.1em] text-[#999999] font-medium">
                              Auto-found
                            </span>
                          )}
                          {c.source === "user" && (
                            <span className="text-[10px] uppercase tracking-[0.1em] text-[#999999] font-medium">
                              Tracked
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-5 text-center">
                    <div className="flex flex-col items-center gap-1.5">
                      <span className="font-serif font-semibold text-xl text-[#1A1A1A]">
                        {c.visibilityScore ?? 0}%
                      </span>
                      <div className="w-24 h-1.5 rounded-full bg-[#E5E2D9] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#6B4CE6]"
                          style={{
                            width: `${Math.min(100, c.visibilityScore ?? 0)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-5 text-center font-serif text-lg font-medium text-[#1A1A1A]">
                    {c.citationShare ?? 0}%
                  </td>
                  <td className="px-4 py-5 text-center text-sm text-[#666666]">
                    <div className="font-semibold text-[#1A1A1A]">
                      {c.mentions ?? 0} text
                    </div>
                    <div className="text-xs">{c.citations ?? 0} cited</div>
                  </td>
                  <td className="px-7 py-5 text-right">
                    {c.userAbsent ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[11px] font-semibold border uppercase tracking-[0.1em] bg-[#F9ECEC] text-[#8B3A3A] border-[#E2B8B8]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#8B3A3A]" />
                        You absent
                      </span>
                    ) : (c.visibilityScore ?? 0) > 0 ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[11px] font-semibold border uppercase tracking-[0.1em] bg-[#E8F0ED] text-[#2F5C4F] border-[#B4D4CA]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#2F5C4F]" />
                        Co-present
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-[11px] font-semibold border uppercase tracking-[0.1em] bg-[#F5F5F5] text-[#999999] border-[#E5E2D9]">
                        Not seen
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
