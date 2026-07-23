export const Wordmark = ({ size = "default", className = "" }) => {
  const sizes = {
    default: { fontSize: "26px" },
    sm: { fontSize: "21px" },
  };
  const s = sizes[size] || sizes.default;

  return (
    <span
      className={`inline-flex items-baseline select-none ${className}`}
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: s.fontSize,
        letterSpacing: "0.02em",
        color: "var(--text-1)",
      }}
    >
      percee
      {/* the declared letter */}
      <span style={{ color: "var(--accent)" }}>v</span>
    </span>
  );
};
