import React, { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, CheckCircle2, XCircle, Link2, AlertCircle } from "lucide-react";

/**
 * Highlights any occurrence of the brand aliases inside the AIO text.
 * Case-insensitive, matches on word boundaries.
 */
function highlightBrand(text, aliases) {
  if (!text || !aliases?.length) return text;
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((a) => a.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"));
  const re = new RegExp(`(^|[^\\w])(${escaped.join("|")})(?=$|[^\\w])`, "gi");
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index + match[1].length));
    parts.push(
      <mark
        key={match.index}
        className="bg-[#FFF8F5] text-[#D9531E] font-semibold px-0.5 rounded-sm"
      >
        {match[2]}
      </mark>
    );
    lastIndex = match.index + match[0].length;
  }
  parts.push(text.slice(lastIndex));
  return parts;
}

function StatusPill({ visible, aioPresent, error, isBranded }) {
  if (error) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-[#F9ECEC] text-[#8B3A3A] text-[10px] font-bold uppercase tracking-wider">
        <AlertCircle className="w-3 h-3" /> Error
      </span>
    );
  }
  if (!aioPresent) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-[#F3F0E6] text-[#666666] text-[10px] font-bold uppercase tracking-wider">
        No AI Overview
      </span>
    );
  }
  if (visible) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-[#E8F0ED] text-[#2F5C4F] text-[10px] font-bold uppercase tracking-wider">
        <CheckCircle2 className="w-3 h-3" /> Visible {isBranded && "(branded)"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-[#F9ECEC] text-[#8B3A3A] text-[10px] font-bold uppercase tracking-wider">
      <XCircle className="w-3 h-3" /> Absent
    </span>
  );
}

export const AioEvidenceRow = ({ prompt, brandAliases }) => {
  const [expanded, setExpanded] = useState(false);
  const {
    prompt: query,
    aioPresent,
    aioText,
    aioReferences,
    brandMentioned,
    brandCited,
    visible,
    competitorsFound,
    competitorsCited,
    isBrandedQuery,
    source,
    error,
  } = prompt;

  const hasContent = aioPresent || error;

  return (
    <div
      data-testid={`aio-evidence-row`}
      className={`border-b border-[#E5E2D9] last:border-0 ${
        isBrandedQuery ? "bg-[#FFFBF6]" : "bg-white"
      }`}
    >
      <button
        onClick={() => hasContent && setExpanded((v) => !v)}
        className={`w-full text-left px-6 py-4 flex items-start gap-3 hover:bg-[#FDFBF7] transition-colors ${
          !hasContent ? "cursor-default" : ""
        }`}
      >
        <div className="mt-1 shrink-0">
          {hasContent ? (
            expanded ? (
              <ChevronDown className="w-4 h-4 text-[#666666]" />
            ) : (
              <ChevronRight className="w-4 h-4 text-[#666666]" />
            )
          ) : (
            <span className="w-4 h-4 inline-block" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-[#1A1A1A] font-medium break-words">{query}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusPill
              visible={visible}
              aioPresent={aioPresent}
              error={error}
              isBranded={isBrandedQuery}
            />
            {isBrandedQuery && (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-[#FFF8F5] text-[#D9531E] px-2 py-0.5 rounded-sm">
                Branded query
              </span>
            )}
            {brandMentioned && (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-[#E8F0ED] text-[#2F5C4F] px-2 py-0.5 rounded-sm">
                Mentioned in text
              </span>
            )}
            {brandCited && (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-[#EBF3FF] text-[#4B6B94] px-2 py-0.5 rounded-sm">
                Domain cited
              </span>
            )}
            {competitorsFound?.length > 0 && (
              <span className="text-[10px] uppercase tracking-wider text-[#8B3A3A] font-semibold">
                Competitors: {competitorsFound.join(", ")}
              </span>
            )}
            {source && (
              <span className="text-[10px] uppercase tracking-wider text-[#999999]">
                {source.replace(/_/g, " ")}
              </span>
            )}
          </div>
        </div>
      </button>

      {expanded && hasContent && (
        <div className="px-14 pb-6 pt-2 space-y-4">
          {error ? (
            <div className="text-xs text-[#8B3A3A] bg-[#F9ECEC] border border-[#E2B8B8] p-3 rounded-sm">
              Bright Data returned an error for this query: {error}
            </div>
          ) : (
            <>
              <div>
                <h5 className="text-[10px] uppercase tracking-wider text-[#666666] font-bold mb-2">
                  Google AI Overview
                </h5>
                <div className="text-sm text-[#1A1A1A] leading-relaxed whitespace-pre-line bg-[#FDFBF7] border border-[#E5E2D9] p-4 rounded-sm">
                  {highlightBrand(aioText, brandAliases)}
                </div>
              </div>
              {aioReferences?.length > 0 && (
                <div>
                  <h5 className="text-[10px] uppercase tracking-wider text-[#666666] font-bold mb-2 flex items-center gap-1">
                    <Link2 className="w-3 h-3" /> Citations ({aioReferences.length})
                  </h5>
                  <ul className="space-y-1.5">
                    {aioReferences.map((ref, i) => (
                      <li key={i} className="text-xs">
                        <a
                          href={ref.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-[#4B6B94] hover:text-[#1A1A1A] hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span className="font-medium">{ref.source || ref.domain || "source"}</span>
                          {ref.title && <span className="text-[#666666]"> — {ref.title}</span>}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {competitorsCited?.length > 0 && (
                <div className="text-xs text-[#8B3A3A]">
                  <strong>Competitor domains cited:</strong> {competitorsCited.join(", ")}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const AioEvidenceList = ({ prompts, brandAliases, title, subtitle, testId, emptyLabel = "No queries yet." }) => (
  <div data-testid={testId} className="bg-white border border-[#E5E2D9] rounded-sm">
    <div className="px-6 py-5 border-b border-[#E5E2D9]">
      <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] leading-tight">{title}</h3>
      {subtitle && <p className="text-sm text-[#666666] mt-1">{subtitle}</p>}
    </div>
    {prompts.length === 0 ? (
      <div className="px-6 py-10 text-center text-sm text-[#999999]">{emptyLabel}</div>
    ) : (
      <div className="divide-y divide-[#E5E2D9]">
        {prompts.map((p, i) => (
          <AioEvidenceRow key={i} prompt={p} brandAliases={brandAliases} />
        ))}
      </div>
    )}
  </div>
);
