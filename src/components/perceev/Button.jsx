import { useState } from "react";

const variants = {
  primary: {
    rest: { background: "var(--accent)", color: "var(--accent-fg)", border: "none" },
    hover: { background: "var(--accent-hover)" },
  },
  secondary: {
    rest: {
      background: "transparent",
      color: "var(--text-1)",
      border: "1px solid var(--border-3)",
    },
    hover: { background: "var(--bg-2)", borderColor: "var(--text-1)" },
  },
  ghost: {
    rest: {
      background: "transparent",
      color: "var(--text-2)",
      border: "1px solid transparent",
    },
    hover: { color: "var(--text-1)", background: "var(--bg-2)" },
  },
  danger: {
    rest: {
      background: "var(--crit-bg)",
      color: "var(--crit)",
      border: "1px solid var(--crit-border)",
    },
    hover: { background: "var(--crit)", color: "#fff", borderColor: "var(--crit)" },
  },
};

const sizes = {
  sm: { padding: "6px 14px", fontSize: "var(--type-label-sm)", lineHeight: "var(--control-h-sm)", minHeight: "var(--control-h-sm)" },
  md: { padding: "8px 20px", fontSize: "var(--type-label)", lineHeight: "var(--control-h-md)", minHeight: "var(--control-h-md)" },
  lg: { padding: "12px 28px", fontSize: "11px", lineHeight: "var(--control-h-lg)", minHeight: "var(--control-h-lg)" },
};

export const Button = ({ variant = "primary", size = "md", disabled, className = "", style, children, ...props }) => {
  const [hover, setHover] = useState(false);
  const v = variants[variant] || variants.primary;
  const s = sizes[size] || sizes.md;
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    borderRadius: "var(--radius-1)",
    fontFamily: "var(--font-mono)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "all var(--dur-fast) var(--ease-out)",
    outline: "none",
    ...s,
    ...v.rest,
    ...(hover && !disabled ? v.hover : {}),
    ...style,
  };

  return (
    <button
      style={base}
      disabled={disabled}
      className={className}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...props}
    >
      {children}
    </button>
  );
};
