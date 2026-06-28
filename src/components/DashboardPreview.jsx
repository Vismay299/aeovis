// Static, non-interactive editorial mock of the dashboard used on the landing page.
export const DashboardPreview = () => {
  const prompts = [
    { p: "Best AI visibility tracking tools", r: "2" },
    { p: "How does Brightwave compare?", r: "1" },
    { p: "Affordable analytics for startups", r: "5" },
    { p: "Enterprise brand monitoring", r: "—" },
  ];

  return (
    <div className="bg-white border border-[#E5E2D9] rounded-sm select-none pointer-events-none">
      {/* window chrome */}
      <div className="h-10 border-b border-[#E5E2D9] flex items-center px-4 gap-3">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full border border-[#E5E2D9]" />
          <span className="w-2.5 h-2.5 rounded-full border border-[#E5E2D9]" />
          <span className="w-2.5 h-2.5 rounded-full border border-[#E5E2D9]" />
        </div>
        <span className="text-[11px] text-[#999999] font-mono tracking-tight">
          answerrank.app/dashboard
        </span>
      </div>

      <div className="p-6">
        <div className="flex items-end justify-between mb-6">
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[#666666] font-medium">
              Analyzing
            </span>
            <div className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">
              Brightwave
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-sm text-[10px] font-semibold border uppercase tracking-[0.1em] bg-[#FDF6E3] text-[#8F6614] border-[#E6D5A7]">
            Moderate
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          {/* hero score */}
          <div className="bg-[#D9531E] text-white rounded-sm p-4 flex flex-col justify-between">
            <span className="text-[9px] uppercase tracking-[0.15em] text-white/80 font-medium">
              Visibility
            </span>
            <div className="flex items-baseline gap-0.5 mt-3">
              <span className="font-serif text-4xl font-semibold leading-none">64</span>
              <span className="text-xs text-white/70">/100</span>
            </div>
          </div>
          {[
            { l: "Prompts", v: "24" },
            { l: "Rivals", v: "7" },
          ].map((k, i) => (
            <div key={i} className="bg-white border border-[#E5E2D9] rounded-sm p-4 flex flex-col justify-between">
              <span className="text-[9px] uppercase tracking-[0.15em] text-[#666666] font-medium">
                {k.l}
              </span>
              <span className="font-serif text-4xl font-semibold text-[#1A1A1A] leading-none mt-3">
                {k.v}
              </span>
            </div>
          ))}
        </div>

        <div className="border border-[#E5E2D9] rounded-sm">
          <div className="px-4 py-2.5 border-b border-[#1A1A1A] text-[10px] uppercase tracking-[0.15em] text-[#1A1A1A] font-semibold">
            Top Prompts
          </div>
          {prompts.map((row, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-4 py-3 border-b border-[#E5E2D9] last:border-0"
            >
              <span className="text-xs text-[#1A1A1A] truncate pr-3">{row.p}</span>
              <span
                className={`font-serif font-semibold text-base ${
                  row.r === "—" ? "text-[#999999]" : "text-[#2F5C4F]"
                }`}
              >
                {row.r === "—" ? "—" : `#${row.r}`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
