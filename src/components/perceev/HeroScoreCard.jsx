import { ScoreMeter } from "./ScoreMeter";

export const HeroScoreCard = ({
  score,
  tierText,
  testId,
  trend,
  stats = [],
  onMethodologyClick,
}) => {
  const isNumeric = typeof score === "number";

  return (
    <div
      data-testid={testId}
      style={{
        background: "var(--accent)",
        color: "var(--accent-fg)",
        borderRadius: "var(--radius-2)",
        padding: "var(--space-7)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        minHeight: "210px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Radial glow overlay — decorative, hidden in print */}
      <div
        data-print="hide"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 20% 30%, rgba(255,255,255,0.08) 0%, transparent 60%)",
          pointerEvents: "none",
        }}
      />

      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "var(--accent-fg)",
              opacity: 0.75,
            }}
          >
            Share of AI answers
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            {trend != null && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-1)",
                  background:
                    parseFloat(trend) > 0 ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)",
                }}
              >
                {parseFloat(trend) > 0 ? "+" : ""}
                {trend}%
              </span>
            )}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                padding: "2px 8px",
                borderRadius: "var(--radius-1)",
                border: "1px solid rgba(255,255,255,0.25)",
              }}
            >
              {tierText}
            </span>
          </div>
        </div>
        <div style={{ marginTop: "var(--space-4)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "72px",
                fontWeight: 600,
                letterSpacing: "-0.035em",
                lineHeight: 1,
              }}
            >
              {score}
            </span>
            {isNumeric && (
              <span style={{ fontSize: "24px", opacity: 0.6, fontFamily: "var(--font-sans)" }}>
                /100
              </span>
            )}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              marginTop: "var(--space-2)",
              fontSize: "12px",
              opacity: 0.8,
            }}
          >
            {stats.map((stat, i) => (
              <div key={i}>{stat}</div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ position: "relative", zIndex: 1, marginTop: "var(--space-5)" }}>
        <ScoreMeter segments={40} value={isNumeric ? score : 0} />
      </div>
    </div>
  );
};
