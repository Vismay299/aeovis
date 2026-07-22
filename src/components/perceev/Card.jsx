export const Card = ({ variant = "padded", className = "", children, style: outerStyle }) => {
  const padded = variant !== "flush";

  return (
    <div
      className={className}
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--radius-2)",
        padding: padded ? "var(--space-6)" : 0,
        ...outerStyle,
      }}
    >
      {children}
    </div>
  );
};
