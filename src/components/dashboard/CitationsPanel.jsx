import React from "react";
import { Globe, Link as LinkIcon } from "lucide-react";

export const CitationsPanel = ({ result }) => {
  const topDomains = result.topDomains || [];
  const totalCitations = (result.rawResults || []).reduce(
    (sum, r) => sum + ((r.aio_citations || r.aio_references || []).length),
    0
  );

  if (totalCitations === 0 && topDomains.length === 0) {
    return (
      <div className="bg-white border border-[#E5E2D9] rounded-sm p-12 text-center">
        <p className="text-[#999999] text-sm">
          No AI Overview citations were captured in this scan.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="citations-panel" className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-white border border-[#E5E2D9] rounded-sm p-6">
          <div className="text-xs uppercase tracking-[0.1em] text-[#666666] font-semibold mb-2 flex items-center gap-2">
            <LinkIcon className="w-4 h-4 text-[#D9531E]" />
            Total citations
          </div>
          <div className="font-serif text-4xl text-[#1A1A1A] font-semibold">
            {totalCitations}
          </div>
          <div className="text-sm text-[#999999] mt-1">
            URLs referenced across all AI Overviews
          </div>
        </div>
        <div className="bg-white border border-[#E5E2D9] rounded-sm p-6">
          <div className="text-xs uppercase tracking-[0.1em] text-[#666666] font-semibold mb-2 flex items-center gap-2">
            <Globe className="w-4 h-4 text-[#D9531E]" />
            Your domain share
          </div>
          <div className="font-serif text-4xl text-[#1A1A1A] font-semibold">
            {result.brandCitationSharePct ?? 0}%
          </div>
          <div className="text-sm text-[#999999] mt-1">
            of non-branded queries where the AIO cites your domain
          </div>
        </div>
      </div>

      <div className="bg-white border border-[#E5E2D9] rounded-sm">
        <div className="px-7 py-6 border-b border-[#E5E2D9]">
          <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">
            Top cited domains
          </h3>
          <p className="text-sm text-[#666666] mt-1">
            Domains Google&apos;s AI Overview reaches for when answering your category
            queries.
          </p>
        </div>
        <div className="divide-y divide-[#E5E2D9]">
          {topDomains.map((item, i) => (
            <div
              key={item.domain}
              className="p-5 px-7 flex items-center justify-between hover:bg-[#FDFBF7] transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-[#999999] font-medium w-4">{i + 1}</span>
                <span
                  className={`font-semibold ${
                    item.type === "brand"
                      ? "text-[#2F5C4F]"
                      : item.type === "competitor"
                      ? "text-[#8B3A3A]"
                      : "text-[#1A1A1A]"
                  }`}
                >
                  {item.domain}
                </span>
                {item.type === "brand" && (
                  <span className="text-[10px] uppercase tracking-wider bg-[#E8F0ED] text-[#2F5C4F] px-1.5 py-0.5 rounded-sm">
                    Own Domain
                  </span>
                )}
                {item.type === "competitor" && (
                  <span className="text-[10px] uppercase tracking-wider bg-[#F9ECEC] text-[#8B3A3A] px-1.5 py-0.5 rounded-sm">
                    Competitor
                  </span>
                )}
              </div>
              <div className="text-sm text-[#666666]">
                <span className="font-semibold text-[#1A1A1A]">{item.count}</span>{" "}
                citation{item.count === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
