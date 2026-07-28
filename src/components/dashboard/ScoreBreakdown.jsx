import React from "react";
import { motion } from "framer-motion";
import { ShieldCheck, MessageSquare, LineChart, Award, HelpCircle } from "lucide-react";

export const ScoreBreakdown = ({ result }) => {
  if (!result) return null;

  const score = result.visibilityScore ?? 0;
  const mentionRate = result.mentionRatePct ?? 0;
  const sov = result.shareOfVoicePct ?? 0;
  const citationShare = result.brandCitationSharePct ?? 0;
  const ciLow = result.scoreCiLow ?? 0;
  const ciHigh = result.scoreCiHigh ?? 0;

  const metrics = [
    {
      label: "AI Visibility Score",
      value: `${score}%`,
      icon: <Award className="w-5 h-5 text-[var(--lamp-amber)]" />,
      desc: "Headline composite score blending mention volume, ranking position, answer sentiment, and citation authority across B2B queries.",
      color: "bg-[var(--lamp-amber)]",
      progress: score
    },
    {
      label: "Mention Rate",
      value: `${mentionRate}%`,
      icon: <MessageSquare className="w-5 h-5 text-[var(--lamp-green)]" />,
      desc: "The percentage of B2B buyer queries where your brand is active and explicitly recommended by search AI engines.",
      color: "bg-[var(--lamp-green)]",
      progress: mentionRate
    },
    {
      label: "Share of Voice (SOV)",
      value: `${sov}%`,
      icon: <LineChart className="w-5 h-5 text-[var(--lamp-amber)]" />,
      desc: "Your share of recommendations compared directly to key competitors. Indicates B2B mindshare inside AI answer generation.",
      color: "bg-[var(--lamp-amber)]",
      progress: sov
    },
    {
      label: "Citation Share",
      value: `${citationShare}%`,
      icon: <ShieldCheck className="w-5 h-5 text-[var(--lamp-blue)]" />,
      desc: "The percentage of queries where your domain is cited in the reference links. Essential for organic referral traffic.",
      color: "bg-[var(--lamp-blue)]",
      progress: citationShare
    }
  ];

  return (
    <div className="bg-[var(--panel-1)] border border-[var(--rule-1)] rounded-sm p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--rule-1)] pb-5 mb-6">
        <div>
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--text-2)] font-medium">
            Performance breakdown
          </span>
          <h3 className="font-serif text-2xl font-semibold text-[var(--text-1)] mt-1">
            Score Decomposition
          </h3>
        </div>
        <div className="flex flex-col items-end text-right">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">90% Bayesian Credible Interval</span>
          <span className="text-base font-serif font-bold text-[var(--text-1)] mt-0.5">
            Likely Visibility Range: {ciLow}%–{ciHigh}%
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {metrics.map((m, idx) => (
          <motion.div
            key={m.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: idx * 0.05 }}
            className="flex flex-col justify-between border border-[var(--rule-1)] rounded-sm p-5 hover:border-[var(--text-1)] transition-colors bg-[var(--panel-1)]"
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-bold text-[var(--text-2)] uppercase tracking-wider">
                  {m.label}
                </span>
                {m.icon}
              </div>
              <span className="font-serif font-bold text-4xl text-[var(--text-1)] block mb-2">
                {m.value}
              </span>
              <p className="text-xs text-[var(--text-2)] leading-relaxed mb-6">
                {m.desc}
              </p>
            </div>
            <div className="w-full bg-[var(--panel-2)] h-1.5 rounded-full overflow-hidden mt-auto">
              <div
                className={`h-full ${m.color}`}
                style={{ width: `${m.progress}%` }}
              />
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
};
