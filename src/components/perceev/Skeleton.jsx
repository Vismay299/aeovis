export const Skeleton = ({ className = "", style: outerStyle, ...props }) => {
  return (
    <div
      className={`relative overflow-hidden rounded-sm ${className}`}
      style={{
        background: "var(--bg-2)",
        ...outerStyle,
      }}
      {...props}
    >
      <div
        className="animate-shimmer"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 50%, transparent 100%)",
        }}
      />
    </div>
  );
};
