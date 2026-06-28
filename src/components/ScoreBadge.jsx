import { tierClasses, tierLabel } from "@/utils/format";

export const ScoreBadge = ({ tier, label, className = "", testId }) => {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center px-2.5 py-1 rounded-sm text-[11px] font-semibold border uppercase tracking-[0.1em] ${tierClasses(
        tier
      )} ${className}`}
    >
      {label || tierLabel(tier)}
    </span>
  );
};
