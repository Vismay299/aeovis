import { rankColor } from "@/utils/format";

export const TopPromptsTable = ({ prompts }) => {
  return (
    <div
      data-testid="top-prompts-table"
      className="bg-white border border-[#E5E2D9] rounded-sm"
    >
      <div className="px-7 py-6 flex items-end justify-between">
        <div>
          <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">
            Top Prompts
          </h3>
          <p className="text-sm text-[#666666] mt-1">
            Where your brand surfaces in AI answers
          </p>
        </div>
        <span className="text-xs uppercase tracking-[0.15em] text-[#999999] font-medium">
          {prompts.length} tracked
        </span>
      </div>

      {prompts.length === 0 ? (
        <div className="px-7 py-14 text-center text-[#999999] text-sm border-t border-[#E5E2D9]" data-testid="top-prompts-empty">
          No prompt data available for this scan.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold px-7 py-3">
                  Prompt
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-center px-4 py-3 w-24">
                  Rank
                </th>
                <th className="text-[11px] uppercase tracking-[0.12em] text-[#1A1A1A] font-semibold text-right px-7 py-3 w-28">
                  Volume
                </th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((p, i) => (
                <tr
                  key={i}
                  data-testid={`prompt-row-${i}`}
                  className="border-b border-[#E5E2D9] last:border-0 hover:bg-[#FDFBF7] transition-colors"
                >
                  <td className="px-7 py-5 text-sm text-[#1A1A1A]">{p.prompt}</td>
                  <td className="px-4 py-5 text-center">
                    <span className={`font-serif font-semibold text-xl ${rankColor(p.rank)}`}>
                      {p.rank === "—" || p.rank == null ? "—" : `#${p.rank}`}
                    </span>
                  </td>
                  <td className="px-7 py-5 text-right text-sm text-[#666666] uppercase tracking-wider text-xs">
                    {p.volume}
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
