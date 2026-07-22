import { ScoreMeter } from "@/components/perceev/ScoreMeter";
import { Badge } from "@/components/perceev/Badge";

export const VerdictModule = () => {
  return (
    <div>
      <h3
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--type-h2)",
          fontWeight: 600,
          letterSpacing: "var(--track-h2)",
          color: "var(--text-1)",
          marginBottom: "var(--space-6)",
        }}
      >
        A typical verdict
      </h3>
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--radius-2)",
          padding: "var(--space-7)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            marginBottom: "var(--space-5)",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--type-display)",
                fontWeight: 600,
                letterSpacing: "var(--track-display)",
                color: "var(--accent)",
                lineHeight: 1,
              }}
            >
              64
            </span>
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "20px",
                color: "var(--text-3)",
              }}
            >
              /100
            </span>
          </div>
          <Badge variant="moderate">Moderate</Badge>
        </div>
        <ScoreMeter segments={40} value={64} />
        <div
          style={{
            marginTop: "var(--space-4)",
            display: "flex",
            gap: "var(--space-8)",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "var(--text-2)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          <span>Mentioned 18/20 AIOs</span>
          <span>Cited in 6/20</span>
        </div>
      </div>
    </div>
  );
};
