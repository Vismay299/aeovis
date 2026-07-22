import { AlertCircle, CheckCircle2, Info, AlertTriangle } from "lucide-react";

const icons = {
  crit: AlertCircle,
  warn: AlertTriangle,
  info: Info,
  good: CheckCircle2,
};

const variantStyles = {
  crit: {
    bg: "var(--crit-bg)",
    border: "var(--crit-border)",
    color: "var(--crit)",
  },
  warn: {
    bg: "var(--warn-bg)",
    border: "var(--warn-border)",
    color: "var(--warn)",
  },
  info: {
    bg: "var(--info-bg)",
    border: "var(--info-border)",
    color: "var(--info)",
  },
  good: {
    bg: "var(--good-bg)",
    border: "var(--good-border)",
    color: "var(--good)",
  },
};

export const Alert = ({
  variant = "info",
  title,
  children,
  action,
  onDismiss,
  className = "",
}) => {
  const s = variantStyles[variant] || variantStyles.info;
  const Icon = icons[variant] || Info;

  return (
    <div
      className={`flex items-start gap-3 ${className}`}
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: "var(--radius-1)",
        padding: "12px 16px",
        color: s.color,
        fontSize: "13px",
        lineHeight: 1.5,
      }}
    >
      <Icon size={18} style={{ flexShrink: 0, marginTop: "1px" }} />
      <div style={{ flex: 1 }}>
        {title && (
          <div style={{ fontWeight: 600, marginBottom: "4px", fontFamily: "var(--font-sans)" }}>
            {title}
          </div>
        )}
        <div>{children}</div>
        {action && <div style={{ marginTop: "var(--space-3)" }}>{action}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: "none",
            border: "none",
            color: s.color,
            cursor: "pointer",
            fontSize: "18px",
            lineHeight: 1,
            padding: 0,
            opacity: 0.6,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
};
