export const ScoreMeter = ({ segments = 40, value = 0, max = 100, className = "" }) => {
  const filled = Math.round((value / max) * segments);
  const clamped = Math.max(0, Math.min(filled, segments));

  return (
    <div
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className={`flex gap-[2px] ${className}`}
    >
      {Array.from({ length: segments }).map((_, i) => (
        <span
          key={i}
          className="flex-1"
          style={{
            height: "6px",
            borderRadius: "var(--radius-round)",
            background: i < clamped ? "var(--accent)" : "var(--meter-track)",
            transition: "background var(--dur-med) var(--ease-out)",
          }}
        />
      ))}
    </div>
  );
};
