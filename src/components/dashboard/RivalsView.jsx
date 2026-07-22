import { Card } from "@/components/perceev/Card";
import { Badge } from "@/components/perceev/Badge";
import { ScoreMeter } from "@/components/perceev/ScoreMeter";

export const RivalsView = ({ competitors = [], results = [], competitorsConfigured }) => {
  const nonBrandedAioCount = (results || []).filter(
    (r) =>
      !(r.is_branded_query ?? r.isBrandedQuery) &&
      !!(r.aio_present ?? r.aioPresent)
  ).length;

  const withSignal = (competitors || []).filter(
    (c) => (c.visibilityScore ?? 0) > 0 || (c.mentions ?? 0) > 0 || (c.citations ?? 0) > 0
  );
  const displayList = withSignal.length > 0 ? withSignal : competitors;

  const configured =
    competitorsConfigured != null ? !!competitorsConfigured : displayList.length > 0;

  return (
    <Card data-testid="competitor-table">
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--space-4)", marginBottom: "var(--space-5)" }}>
        <div>
          <h3
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--type-h3)",
              fontWeight: 600,
              color: "var(--text-1)",
              letterSpacing: "var(--track-h3)",
            }}
          >
            Co-mention context
          </h3>
          <p style={{ fontSize: "13px", color: "var(--text-2)", marginTop: "4px" }}>
            Brands frequently mentioned or cited alongside yours in{" "}
            {nonBrandedAioCount} non-branded AI Overviews.
          </p>
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--text-3)",
            flexShrink: 0,
          }}
        >
          {displayList.length} competitor{displayList.length === 1 ? "" : "s"}
        </span>
      </div>

      {displayList.length === 0 ? (
        <div
          data-testid="competitor-empty"
          style={{
            padding: "var(--space-10)",
            textAlign: "center",
            fontSize: "13px",
            color: "var(--text-3)",
            borderTop: "1px solid var(--border-1)",
          }}
        >
          {configured
            ? "No rival brands were co-mentioned in the AI Overviews for this scan."
            : "No co-mentioned competitors found in AI Overviews yet. Re-run a scan to discover rivals from live answers."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", borderTop: "1px solid var(--border-1)", paddingTop: "var(--space-5)" }}>
          {displayList.map((c, i) => (
            <div
              key={`${c.name}-${i}`}
              data-testid={`competitor-row-${i}`}
              style={{
                background: "var(--bg-0)",
                border: "1px solid var(--border-1)",
                borderRadius: "var(--radius-2)",
                padding: "var(--space-5)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  marginBottom: "var(--space-4)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <div
                    style={{
                      width: "36px",
                      height: "36px",
                      borderRadius: "var(--radius-round)",
                      background: "var(--bg-2)",
                      border: "1px solid var(--border-2)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "var(--text-1)",
                      flexShrink: 0,
                    }}
                  >
                    {(c.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-1)" }}>
                      {c.name}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginTop: "4px" }}>
                      {c.tier && (
                        <Badge variant="neutral">{c.tier}</Badge>
                      )}
                      {c.source === "discovered" && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                          Auto-found
                        </span>
                      )}
                      {c.source === "user" && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                          Tracked
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ textAlign: "right" }}>
                  <div
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: "24px",
                      fontWeight: 600,
                      color: "var(--text-1)",
                      lineHeight: 1,
                    }}
                  >
                    {c.visibilityScore ?? 0}%
                  </div>
                  <div style={{ fontSize: "10px", color: "var(--text-3)", marginTop: "2px" }}>
                    Co-mention rate
                  </div>
                </div>
              </div>

              <ScoreMeter segments={30} value={c.visibilityScore ?? 0} />

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: "var(--space-3)",
                  fontSize: "12px",
                  color: "var(--text-2)",
                }}
              >
                <span>
                  {c.mentions ?? 0} text · {c.citations ?? 0} cited
                </span>
                <div>
                  {c.userAbsent ? (
                    <Badge variant="weak">You absent</Badge>
                  ) : (c.visibilityScore ?? 0) > 0 ? (
                    <Badge variant="strong">Co-present</Badge>
                  ) : (
                    <Badge variant="muted">Not seen</Badge>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};
