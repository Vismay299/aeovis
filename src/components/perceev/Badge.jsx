const variantStyles = {
  strong: {
    bg: "var(--good-bg)",
    color: "var(--good)",
    border: "var(--good-border)",
  },
  moderate: {
    bg: "var(--warn-bg)",
    color: "var(--warn)",
    border: "var(--warn-border)",
  },
  weak: {
    bg: "var(--crit-bg)",
    color: "var(--crit)",
    border: "var(--crit-border)",
  },
  accent: {
    bg: "var(--accent-soft)",
    color: "var(--accent-text)",
    border: "var(--accent-border)",
  },
  neutral: {
    bg: "var(--bg-2)",
    color: "var(--text-2)",
    border: "var(--border-2)",
  },
  muted: {
    bg: "transparent",
    color: "var(--text-3)",
    border: "var(--border-1)",
  },
};

export const tierVariant = (tier) => {
  const map = { strong: "strong", moderate: "moderate", weak: "weak" };
  return map[tier] || "neutral";
};

export const Badge = ({ variant = "neutral", dot, children, className = "" }) => {
  const s = variantStyles[variant] || variantStyles.neutral;

  return (
    <span
      className={`inline-flex items-center gap-1.5 select-none ${className}`}
      style={{
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: "var(--radius-1)",
        padding: "2px 8px",
        fontFamily: "var(--font-display)",
        fontSize: "12px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        lineHeight: "18px",
      }}
    >
      {dot && (
        <span
          style={{
            display: "inline-block",
            width: "5px",
            height: "5px",
            borderRadius: "var(--radius-round)",
            background: s.color,
          }}
        />
      )}
      {children}
    </span>
  );
};
