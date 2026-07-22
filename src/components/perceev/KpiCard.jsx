const tones = {
  neutral: {
    bg: "var(--bg-1)",
    border: "var(--border-1)",
    color: "var(--text-1)",
    numColor: "var(--text-1)",
  },
  good: {
    bg: "var(--good-bg)",
    border: "var(--good-border)",
    color: "var(--good)",
    numColor: "var(--good)",
  },
  warn: {
    bg: "var(--warn-bg)",
    border: "var(--warn-border)",
    color: "var(--warn)",
    numColor: "var(--warn)",
  },
  crit: {
    bg: "var(--crit-bg)",
    border: "var(--crit-border)",
    color: "var(--crit)",
    numColor: "var(--crit)",
  },
};

export const KpiCard = ({ label, value, suffix, sub, tone = "neutral", testId }) => {
  const t = tones[tone] || tones.neutral;
  const displayValue = typeof value === "number" && !Number.isFinite(value) ? "—" : value ?? "—";

  return (
    <div
      data-testid={testId}
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: "var(--radius-2)",
        padding: "var(--space-6)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        minHeight: "150px",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: "var(--text-3)",
        }}
      >
        {label}
      </span>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "36px",
              fontWeight: 600,
              letterSpacing: "-0.03em",
              lineHeight: 1,
              color: t.numColor,
            }}
          >
            {displayValue}
          </span>
          {suffix && displayValue !== "—" && (
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "16px",
                color: "var(--text-3)",
              }}
            >
              {suffix}
            </span>
          )}
        </div>
        {sub && (
          <div
            style={{
              marginTop: "var(--space-2)",
              fontSize: "12px",
              color: "var(--text-3)",
            }}
          >
            {sub}
          </div>
        )}
      </div>
    </div>
  );
};
