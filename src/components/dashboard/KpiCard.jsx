import React, { useState } from "react";
import { motion } from "framer-motion";
import { HelpCircle, X } from "lucide-react";

export const KpiCard = ({ label, value, suffix, sub, index = 0, testId }) => {
  return (
    <motion.div
      data-testid={testId}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.08 }}
      className="bg-white border border-[#E5E2D9] rounded-sm p-7 flex flex-col justify-between min-h-[160px]"
    >
      <span className="text-xs uppercase tracking-[0.15em] text-[#666666] font-medium">
        {label}
      </span>
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-serif text-5xl md:text-6xl font-semibold tracking-tight text-[#1A1A1A] leading-none">
            {value}
          </span>
          {suffix && <span className="text-lg text-[#999999] font-serif">{suffix}</span>}
        </div>
        {sub && <div className="mt-3 text-sm text-[#666666]">{sub}</div>}
      </div>
    </motion.div>
  );
};

export const HeroScoreCard = ({ score, tierText, testId, trend, isMixedTrend, promptSetChanged, historyScores = [], mentionRate, citationShare, scoreCiLow, scoreCiHigh }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const margin = typeof score === "number" && scoreCiLow != null && scoreCiHigh != null ? Math.round(score - scoreCiLow) : 0;

  // Generate sparkline points if we have history
  let sparkline = null;
  if (historyScores.length > 1) {
    // Reverse to chronological order
    const pts = [...historyScores].reverse();
    const max = 100; // Fixed scale 0-100 for visibility score
    const w = 80;
    const h = 30;
    const dx = w / (pts.length - 1);
    const pointsStr = pts.map((val, i) => {
      const x = i * dx;
      const y = h - (val / max) * h;
      return `${x},${y}`;
    }).join(" ");

    sparkline = (
      <svg width={w} height={h} className="absolute bottom-6 right-8 opacity-40" stroke="white" strokeWidth="2" fill="none" viewBox={`-2 -2 ${w+4} ${h+4}`}>
        <polyline points={pointsStr} />
        <circle cx={w} cy={h - (pts[pts.length - 1] / max) * h} r="3" fill="white" stroke="none" />
      </svg>
    );
  }

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
              AI Visibility Score
            </span>
            <HelpCircle className="w-3.5 h-3.5 text-white/60 group-hover:text-white transition-colors" />
          {showTooltip && (
            <div className="absolute left-0 top-6 z-50 bg-[#1A1A1A] text-white text-[11px] p-4 rounded-sm border border-[#E5E2D9]/20 shadow-lg min-w-[240px] leading-relaxed">
              <p className="font-semibold text-white mb-2">How is this calculated?</p>
              <p className="text-white/80 mb-1">Blended Formula: <span className="font-mono text-[#E5E2D9]">85% Mention Visibility + 15% Brand Citation Share</span>.</p>
              <p className="text-white/80 mb-1">Hybrid Probing: <span className="font-mono text-[#E5E2D9]">Google AI Overview (50%) + Perplexity (25%) + ChatGPT (15%) + Gemini (10%)</span>.</p>
              <ul className="list-disc pl-3.5 space-y-1.5 mt-2 text-white/70">
                <li><strong>Mention Visibility:</strong> Average score calculated using the median performance (Mention × Position × Sentiment + Citation Bonus) across runs.</li>
                <li><strong>Brand Citation Share:</strong> The % of queries where the brand domain is cited in the references.</li>
                <li><strong>Intent weighting:</strong> Scores are aggregated using a weighted average: High Intent (3.0x), Comparison (2.0x), Problem Aware (1.5x), Exploratory (1.0x), and Branded (0.5x).</li>
              </ul>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {trend && (
            <span 
              title={
                isMixedTrend && promptSetChanged
                  ? "Trend compares different scoring versions and different prompt sets"
                  : isMixedTrend
                  ? "Trend compares different scoring versions (e.g. v3 vs v6-bayesian-hybrid)"
                  : promptSetChanged
                  ? "Prompt set changed between these scans — trend comparison may be less accurate"
                  : undefined
              }
              className={`text-xs font-semibold px-2 py-0.5 rounded-sm ${parseFloat(trend) > 0 ? "bg-white/20 text-white" : parseFloat(trend) < 0 ? "bg-[#8B3A3A]/40 text-white" : "bg-white/10 text-white/80"}`}
            >
              {parseFloat(trend) > 0 ? "+" : ""}{trend}%{(isMixedTrend || promptSetChanged) ? "*" : ""}
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
          {typeof score === "number" && <span className="text-2xl text-white/70 font-serif">/100</span>}
        </div>
        <div className="flex flex-col gap-1 mt-1 text-xs text-white/80 font-medium">
          {typeof score === "number" && mentionRate !== undefined && (
            <div className="whitespace-nowrap">
              Mention Rate: <span className="font-bold text-white">{mentionRate}%</span>
            </div>
          )}
          {typeof score === "number" && citationShare !== undefined && (
            <div className="whitespace-nowrap">
              Citation Share: <span className="font-bold text-white">{citationShare}%</span>
            </div>
          )}
          {typeof score === "number" && scoreCiLow != null && scoreCiHigh != null && (
            <div className="whitespace-nowrap" data-testid="score-likely-range">
              Likely Range: <span className="font-bold text-white">{scoreCiLow}%–{scoreCiHigh}%</span>
            </div>
          )}
        </div>
      </div>
      {/* subtle editorial measure ticks */}
      <div className="mt-5 flex gap-1 relative z-10">
        {Array.from({ length: 20 }).map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full ${
              i < Math.round(score / 5) ? "bg-white" : "bg-white/25"
            }`}
          />
        ))}
      </div>
        {sparkline}
      </motion.div>

      {/* Methodology Modal */}
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

            <span className="text-[10px] uppercase tracking-[0.2em] text-[#D9531E] font-bold">Methodology</span>
            <h3 className="font-serif text-3xl font-semibold mt-1 mb-6 text-[#1A1A1A]">
              How we calculate this score
            </h3>

            <div className="space-y-6 text-sm text-[#666666] leading-relaxed">
              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">1. Blended Scoring Formula</h4>
                <p>
                  Your headline AI Visibility Score is calculated using a blended formula:
                </p>
                <div className="bg-[#FFF8F5] border-l-2 border-[#D9531E] p-3 font-mono text-xs text-[#D9531E] my-3 rounded-sm">
                  85% Mention Visibility + 15% Brand Citation Share
                </div>
                <ul className="list-disc pl-5 space-y-1.5 mt-2">
                  <li><strong>Mention Visibility (85%):</strong> Measures how frequently and prominently your brand is recommended as a solution.</li>
                  <li><strong>Brand Citation Share (15%):</strong> Measures how often your domain is cited in the reference links across queries.</li>
                </ul>
              </section>

              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">2. Hybrid Probing Weights</h4>
                <p>
                  To represent real B2B buyer behavior, we query multiple top LLM search engines. The score is weighted based on market share:
                </p>
                <div className="grid grid-cols-2 gap-3 my-3">
                  <div className="border border-[#E5E2D9] p-3 rounded-sm bg-white">
                    <span className="text-xs uppercase tracking-wider text-[#666666] block">Google AI Overview</span>
                    <span className="font-serif text-xl font-bold text-[#1A1A1A]">50% Weight</span>
                  </div>
                  <div className="border border-[#E5E2D9] p-3 rounded-sm bg-white">
                    <span className="text-xs uppercase tracking-wider text-[#666666] block">Perplexity</span>
                    <span className="font-serif text-xl font-bold text-[#1A1A1A]">25% Weight</span>
                  </div>
                  <div className="border border-[#E5E2D9] p-3 rounded-sm bg-white">
                    <span className="text-xs uppercase tracking-wider text-[#666666] block">ChatGPT (GPT-4o)</span>
                    <span className="font-serif text-xl font-bold text-[#1A1A1A]">15% Weight</span>
                  </div>
                  <div className="border border-[#E5E2D9] p-3 rounded-sm bg-white">
                    <span className="text-xs uppercase tracking-wider text-[#666666] block">Gemini</span>
                    <span className="font-serif text-xl font-bold text-[#1A1A1A]">10% Weight</span>
                  </div>
                </div>
              </section>

              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">3. Buyer Journey Intent Weighting</h4>
                <p>
                  Visibility on high-intent queries is more valuable than exploratory searches. We apply weights to queries based on B2B intent tier:
                </p>
                <ul className="list-disc pl-5 space-y-1.5 mt-2">
                  <li><strong>High Intent (3.0x weight):</strong> e.g., pricing, categories, direct recommendations.</li>
                  <li><strong>Comparison (2.0x weight):</strong> e.g., "alternative to x", comparison matrices.</li>
                  <li><strong>Problem Aware (1.5x weight):</strong> e.g., "how to fix x", pain-point searches.</li>
                  <li><strong>Exploratory (1.0x weight):</strong> e.g., general definitions, research.</li>
                  <li><strong>Branded (0.5x weight):</strong> e.g., queries containing your own brand.</li>
                </ul>
              </section>

              <section>
                <h4 className="font-serif text-lg font-semibold text-[#1A1A1A] mb-2">4. Bayesian Credible Interval</h4>
                <p>
                  To address sample size variance, we compute a <strong>90% Bayesian Credible Interval</strong> (Likely Range) using a Beta-Binomial conjugate model. This gives you a statistically rigorous margin of certainty for your score.
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
