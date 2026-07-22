export const Input = ({ label, error, id, className = "", style: outerStyle, ...props }) => {
  return (
    <div className={className} style={outerStyle}>
      {label && (
        <label
          htmlFor={id}
          style={{
            display: "block",
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "var(--text-2)",
            marginBottom: "var(--space-2)",
          }}
        >
          {label}
        </label>
      )}
      <input
        id={id}
        style={{
          width: "100%",
          background: "var(--bg-1)",
          border: `1px solid ${error ? "var(--crit-border)" : "var(--border-2)"}`,
          borderRadius: "var(--radius-1)",
          padding: "12px 16px",
          fontFamily: "var(--font-sans)",
          fontSize: "14px",
          color: "var(--text-1)",
          outline: "none",
          transition: "border-color var(--dur-fast), box-shadow var(--dur-fast)",
          boxSizing: "border-box",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "var(--accent)";
          e.target.style.boxShadow = "var(--focus-ring)";
        }}
        onBlur={(e) => {
          e.target.style.borderColor = error ? "var(--crit-border)" : "var(--border-2)";
          e.target.style.boxShadow = "none";
        }}
        {...props}
      />
      {error && (
        <p
          style={{
            marginTop: "var(--space-1)",
            fontSize: "12px",
            color: "var(--crit)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
};
