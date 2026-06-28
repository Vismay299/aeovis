import { motion } from "framer-motion";

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
        {sub && <p className="mt-3 text-sm text-[#666666]">{sub}</p>}
      </div>
    </motion.div>
  );
};

export const HeroScoreCard = ({ score, tierText, testId }) => {
  return (
    <motion.div
      data-testid={testId}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="bg-[#D9531E] text-white rounded-sm p-7 md:p-8 flex flex-col justify-between min-h-[160px] relative overflow-hidden"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.15em] text-white/80 font-medium">
          AI Visibility Score
        </span>
        <span className="text-xs uppercase tracking-[0.12em] text-white/90 font-semibold border border-white/30 rounded-sm px-2 py-0.5">
          {tierText}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mt-4">
        <span className="font-serif text-7xl md:text-8xl font-semibold tracking-tight leading-none">
          {score}
        </span>
        <span className="text-2xl text-white/70 font-serif">/100</span>
      </div>
      {/* subtle editorial measure ticks */}
      <div className="mt-5 flex gap-1">
        {Array.from({ length: 20 }).map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full ${
              i < Math.round(score / 5) ? "bg-white" : "bg-white/25"
            }`}
          />
        ))}
      </div>
    </motion.div>
  );
};
