export const Tabs = ({ items, active, onChange, className = "" }) => {
  return (
    <div className={`flex items-center gap-6 border-b overflow-x-auto ${className}`} style={{ borderColor: "var(--border-1)" }}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            data-testid={item.testId}
            style={{
              background: "none",
              border: "none",
              padding: "0 0 var(--space-3) 0",
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: isActive ? "var(--text-1)" : "var(--text-3)",
              borderBottom: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "color var(--dur-fast), border-color var(--dur-fast)",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            {item.label}
            {item.count != null && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  padding: "2px 6px",
                  borderRadius: "var(--radius-round)",
                  background: isActive ? "var(--accent-soft)" : "var(--bg-2)",
                  color: isActive ? "var(--accent-text)" : "var(--text-2)",
                }}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
