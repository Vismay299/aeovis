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

export const HeroScoreCard = ({ score, tierText, testId, trend, historyScores = [] }) => {
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
        <div className="flex gap-2">
          {trend && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-sm ${parseFloat(trend) > 0 ? "bg-white/20 text-white" : parseFloat(trend) < 0 ? "bg-[#8B3A3A]/40 text-white" : "bg-white/10 text-white/80"}`}>
              {parseFloat(trend) > 0 ? "+" : ""}{trend}%
            </span>
          )}
          <span className="text-xs uppercase tracking-[0.12em] text-white/90 font-semibold border border-white/30 rounded-sm px-2 py-0.5">
            {tierText}
          </span>
        </div>
      </div>
      <div className="flex items-baseline gap-2 mt-4">
        <span className="font-serif text-7xl md:text-8xl font-semibold tracking-tight leading-none">
          {score}
        </span>
        <span className="text-2xl text-white/70 font-serif">/100</span>
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
  );
};
