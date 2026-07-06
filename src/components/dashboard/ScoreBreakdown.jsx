import React from "react";
import { motion } from "framer-motion";

const TIER_LABELS = {
  high_intent: "High Intent",
  comparison: "Comparison",
  problem_aware: "Problem Aware",
  exploratory: "Exploratory",
  branded: "Branded"
};

const TIER_DESC = {
  high_intent: "Queries indicating high buy intent (pricing, best lists, software category)",
  comparison: "Queries directly comparing alternatives (x vs y, rival options)",
  problem_aware: "Queries focused on solving a pain point, pre-category discovery",
  exploratory: "General research, definition queries, and broad learning",
  branded: "Queries explicitly referencing your brand name"
};

const TIER_COLORS = {
  high_intent: "bg-[#D9531E]", // orange
  comparison: "bg-[#2F5C4F]", // green
  problem_aware: "bg-[#8F6614]", // gold/yellow
  exploratory: "bg-[#4B6B94]", // blue
  branded: "bg-[#7A4B94]" // purple
};

export const ScoreBreakdown = ({ breakdown }) => {
  const tiers = Object.keys(TIER_LABELS);

  return (
    <div className="bg-white border border-[#E5E2D9] rounded-sm p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#E5E2D9] pb-5 mb-6">
        <div>
          <span className="text-xs uppercase tracking-[0.15em] text-[#666666] font-medium">
            AEO Intent Analysis
          </span>
          <h3 className="font-serif text-2xl font-semibold text-[#1A1A1A] mt-1">
            Visibility by Buyer Intent Tier
          </h3>
        </div>
        <p className="text-xs text-[#666666] max-w-sm leading-relaxed">
          Scores show your composite visibility across different stages of the B2B buyer journey, weighted by search importance.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
        {tiers.map((tierKey, index) => {
          const score = breakdown[tierKey] ?? 0.0;
          return (
            <motion.div
              key={tierKey}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: index * 0.05 }}
              className="flex flex-col justify-between border border-[#E5E2D9] rounded-sm p-5 hover:border-[#1A1A1A] transition-colors bg-[#FDFBF7]"
            >
              <div>
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-xs font-bold text-[#1A1A1A] uppercase tracking-wider">
                    {TIER_LABELS[tierKey]}
                  </span>
                  <span className="font-serif font-bold text-lg text-[#D9531E]">
                    {score}%
                  </span>
                </div>
                <p className="text-[10px] text-[#888888] leading-normal mb-4">
                  {TIER_DESC[tierKey]}
                </p>
              </div>
              <div className="w-full bg-[#F3F0E6] h-1.5 rounded-full overflow-hidden mt-auto">
                <div 
                  className={`h-full ${TIER_COLORS[tierKey]}`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
