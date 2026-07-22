import { ScoreMeter } from "@/components/perceev/ScoreMeter";
import { Badge } from "@/components/perceev/Badge";

export const ScoreBand = ({ score, tier, trend, stats = [], engineChips, scoreLabel }) => {
  const isNumeric = typeof score === "number";

  return (
    <div
      style={{
        position: "relative",
        background: "var(--bg-1)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--radius-2)",
        padding: "var(--space-7)",
        overflow: "hidden",
      }}
    >
      {/* Radial glow behind the score */}
      <div
        style={{
          position: "absolute",
          top: "-20%",
          right: "-10%",
          width: "50%",
          height: "140%",
          background:
            "radial-gradient(ellipse, rgba(232,99,44,0.08) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: "var(--space-7)" }}>
        {/* Score numeral */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "6px",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "84px",
              fontWeight: 600,
              letterSpacing: "var(--track-data)",
              lineHeight: 1,
              color: "var(--accent)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {score}
          </span>
          {isNumeric && (
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "22px",
                color: "var(--text-3)",
              }}
            >
              /100
            </span>
          )}
        </div>

        {/* Badges + stats */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
            flex: 1,
            minWidth: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            {scoreLabel && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--text-3)",
                }}
              >
                {scoreLabel}
              </span>
            )}
            {tier && <Badge variant={tier}>{tier}</Badge>}
            {trend != null && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 500,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-1)",
                  background:
                    parseFloat(trend) > 0
                      ? "var(--good-bg)"
                      : parseFloat(trend) < 0
                      ? "var(--crit-bg)"
                      : "var(--bg-2)",
                  color:
                    parseFloat(trend) > 0
                      ? "var(--good)"
                      : parseFloat(trend) < 0
                      ? "var(--crit)"
                      : "var(--text-2)",
                }}
              >
                {parseFloat(trend) > 0 ? "+" : ""}
                {trend}%
              </span>
            )}
            {engineChips && engineChips.map((chip, i) => (
              <span
                key={i}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  padding: "2px 6px",
                  borderRadius: "var(--radius-1)",
                  background: "var(--bg-2)",
                  color: "var(--text-2)",
                  border: "1px solid var(--border-2)",
                }}
              >
                {chip.label} {chip.value}%
              </span>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              gap: "var(--space-7)",
              flexWrap: "wrap",
              fontSize: "13px",
              color: "var(--text-2)",
            }}
          >
            {stats.map((stat, i) => (
              <div key={i}>
                <span style={{ color: "var(--text-1)", fontWeight: 600 }}>
                  {stat.value}
                </span>{" "}
                {stat.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: "var(--space-6)", position: "relative", zIndex: 1 }}>
        <ScoreMeter segments={40} value={isNumeric ? score : 0} />
      </div>
    </div>
  );
};
