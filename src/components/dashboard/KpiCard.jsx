import React, { useState } from "react";
import { motion } from "framer-motion";
import { HelpCircle, X } from "lucide-react";

export const KpiCard = ({ label, value, suffix, sub, index = 0, testId, tone = "neutral" }) => {
  const tones = {
    neutral: "bg-white border-[#E5E2D9] text-[#1A1A1A]",
    warning: "bg-[#FDF6E3] border-[#E6D5A7] text-[#8F6614]",
    critical: "bg-[#F9ECEC] border-[#E2B8B8] text-[#8B3A3A]",
    good: "bg-[#E8F0ED] border-[#B4D4CA] text-[#2F5C4F]",
  };

  // Prevent React NaN warning if numeric value hasn't resolved yet
  const displayValue =
    typeof value === "number" && !Number.isFinite(value) ? "—" : value ?? "—";

  return (
    <motion.div
      data-testid={testId}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      className={`border rounded-sm p-6 flex flex-col justify-between min-h-[150px] ${tones[tone] || tones.neutral}`}
    >
      <span className="text-xs uppercase tracking-[0.15em] font-medium opacity-70">{label}</span>
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-serif text-4xl md:text-5xl font-semibold tracking-tight leading-none">
            {displayValue}
          </span>
          {suffix && displayValue !== "—" && (
            <span className="text-base opacity-60 font-serif">{suffix}</span>
          )}
        </div>
        {sub && <div className="mt-2 text-xs opacity-70">{sub}</div>}
      </div>
    </motion.div>
  );
};

export const HeroScoreCard = ({
  score,
  tierText,
  testId,
  trend,
  mentionRate,
  citationShare,
  aioCoverage,
  nonBrandedCount,
  brandedVisibility,
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <motion.div
        data-testid={testId}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="bg-[#D9531E] text-white rounded-sm p-7 md:p-8 flex flex-col justify-between min-h-[190px] relative overflow-hidden"
      >
        <div className="flex items-center justify-between">
          <div
            className="flex items-center gap-1.5 relative cursor-pointer select-none group"
            onClick={() => setShowModal(true)}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            <span className="text-xs uppercase tracking-[0.15em] text-white/80 font-medium">
              AI Overview Visibility
            </span>
            <HelpCircle className="w-3.5 h-3.5 text-white/60 group-hover:text-white transition-colors" />
            {showTooltip && (
              <div className="absolute left-0 top-6 z-50 bg-[#1A1A1A] text-white text-[11px] p-4 rounded-sm border border-[#E5E2D9]/20 shadow-lg min-w-[260px] leading-relaxed">
                <p className="font-semibold text-white mb-2">How is this calculated?</p>
                <p className="text-white/80">
                  We probe Google AI Overview (via Bright Data) for every tracked
                  non-branded query. The score is:
                </p>
                <div className="mt-2 mb-2 p-2 rounded-sm bg-white/10 font-mono text-[10px] text-[#FFE5D9]">
                  visible non-branded queries with AIO ÷ total non-branded queries with AIO
                </div>
                <p className="text-white/80">
                  A query is "visible" if the brand is mentioned in the AIO text OR the
                  brand&apos;s domain is cited in the references. Branded queries are
                  tracked separately in the "Brand Presence" panel.
                </p>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {trend != null && (
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-sm ${
                  parseFloat(trend) > 0
                    ? "bg-white/20 text-white"
                    : parseFloat(trend) < 0
                    ? "bg-[#8B3A3A]/40 text-white"
                    : "bg-white/10 text-white/80"
                }`}
              >
                {parseFloat(trend) > 0 ? "+" : ""}
                {trend}%
              </span>
            )}
            <span className="text-xs uppercase tracking-[0.12em] text-white/90 font-semibold border border-white/30 rounded-sm px-2 py-0.5">
              {tierText}
            </span>
          </div>
        </div>
        <div className="mt-4">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-7xl md:text-8xl font-semibold tracking-tight leading-none">
              {score}
            </span>
            {typeof score === "number" && (
              <span className="text-2xl text-white/70 font-serif">/100</span>
            )}
          </div>
          <div className="flex flex-col gap-1 mt-2 text-xs text-white/80 font-medium">
            {typeof score === "number" && nonBrandedCount != null && (
              <div className="whitespace-nowrap">
                Across{" "}
                <span className="font-bold text-white">{nonBrandedCount}</span> non-branded
                queries
              </div>
            )}
            {typeof score === "number" && mentionRate != null && (
              <div className="whitespace-nowrap">
                Mentioned in text: <span className="font-bold text-white">{mentionRate}%</span>
              </div>
            )}
            {typeof score === "number" && citationShare != null && (
              <div className="whitespace-nowrap">
                Domain cited: <span className="font-bold text-white">{citationShare}%</span>
              </div>
            )}
            {typeof score === "number" && aioCoverage != null && (
              <div className="whitespace-nowrap">
                AIO coverage: <span className="font-bold text-white">{aioCoverage}%</span>
              </div>
            )}
            {typeof score === "number" && brandedVisibility != null && (
              <div className="whitespace-nowrap">
                Brand presence:{" "}
                <span className="font-bold text-white">{brandedVisibility}%</span>
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex gap-1 relative z-10">
          {Array.from({ length: 20 }).map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${
                typeof score === "number" && i < Math.round(score / 5) ? "bg-white" : "bg-white/25"
              }`}
            />
          ))}
        </div>
      </motion.div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1A1A1A]/40 backdrop-blur-sm print:hidden">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-[#FDFBF7] border border-[#E5E2D9] rounded-sm p-6 md:p-8 max-w-2xl w-full shadow-2xl relative max-h-[85vh] overflow-y-auto text-[#1A1A1A]"
          >
            <button
              onClick={() => setShowModal(false)}
              className="absolute top-4 right-4 p-1.5 hover:bg-[#E5E2D9]/40 rounded-sm transition-colors text-[#666666] hover:text-[#1A1A1A]"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>

            <span className="text-[10px] uppercase tracking-[0.2em] text-[#D9531E] font-bold">
              Methodology
            </span>
            <h3 className="font-serif text-3xl font-semibold mt-1 mb-6 text-[#1A1A1A]">
              How we calculate this score
            </h3>

            <div className="space-y-6 text-sm text-[#666666] leading-relaxed">
              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">
                  1. Single source of truth: Google AI Overview
                </h4>
                <p>
                  For every tracked query we hit Google via Bright Data&apos;s SERP API and
                  parse the AI Overview block that Google actually returned. No LLM
                  hallucinations, no synthetic prompts — just what real users see when
                  Google answers the query.
                </p>
              </section>

              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">
                  2. Branded vs non-branded queries
                </h4>
                <p>
                  We tag every query as branded (contains the brand name or its aliases)
                  or non-branded. The headline score only uses non-branded queries so
                  searching your own name doesn&apos;t artificially inflate the number.
                </p>
              </section>

              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">
                  3. Simple, transparent scoring
                </h4>
                <div className="bg-[#FFF8F5] border-l-2 border-[#D9531E] p-3 font-mono text-xs text-[#D9531E] my-3 rounded-sm">
                  Score = visible non-branded AIOs ÷ non-branded queries with an AIO
                </div>
                <p>
                  A query counts as visible if the brand is mentioned in the AI Overview
                  text OR the brand&apos;s domain appears in the citation references.
                </p>
              </section>

              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">
                  4. Fail loudly
                </h4>
                <p>
                  If Google doesn&apos;t serve an AI Overview for enough of your queries
                  (coverage &lt; 30%) or the SERP API errors out on more than 40% of
                  queries, we flag the scan as a data-source issue instead of showing a
                  fake 0%.
                </p>
              </section>
            </div>

            <div className="mt-8 pt-4 border-t border-[#E5E2D9] flex justify-end">
              <button
                onClick={() => setShowModal(false)}
                className="bg-[#1A1A1A] text-white hover:bg-[#333333] px-6 py-2.5 rounded-sm text-xs uppercase tracking-wider font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </>
  );
};
