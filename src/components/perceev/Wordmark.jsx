export const Wordmark = ({ size = "default", className = "" }) => {
  const sizes = {
    default: { fontSize: "24px", letterSpacing: "-0.02em" },
    sm: { fontSize: "18px", letterSpacing: "-0.01em" },
  };
  const s = sizes[size] || sizes.default;

  return (
    <span
      className={`inline-flex items-baseline font-semibold select-none ${className}`}
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: s.fontSize,
        letterSpacing: s.letterSpacing,
        color: "var(--text-1)",
      }}
    >
      percee
      <span style={{ color: "var(--accent)" }}>v</span>
    </span>
  );
};
