import { barWidthPct, formatPercent } from "./chartMath";
import { DeltaChip } from "./DeltaChip";

/**
 * The visibility rank board — a constituency-results rundown, not a re-sort:
 * `rows` is rendered in the order given (rank numeral = array index + 1), so
 * callers control ranking. Owns its own panel chrome (background, hairline
 * border, sharp corners — DESIGN.md) so it drops straight into a dashboard
 * grid, matching the KpiCard/ScoreBand convention.
 *
 * @param {{name: string, value: number, delta?: number|null, isSelf?: boolean}[]} rows
 * @param {"you"|"accent"|"rival"|"good"|null} [keyline] optional 3px top-edge party-color keyline
 */
export const RankTable = ({ rows, keyline = null, testId = "rank-table" }) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  const maxValue = safeRows.reduce((m, r) => (typeof r.value === "number" && r.value > m ? r.value : m), 0);

  return (
    <div
      data-testid={testId}
      style={{
        background: "var(--bg-1)",
        borderTop: keyline ? `3px solid var(--${keyline})` : "1px solid var(--border-1)",
        borderRight: "1px solid var(--border-1)",
        borderBottom: "1px solid var(--border-1)",
        borderLeft: "1px solid var(--border-1)",
        borderRadius: "var(--radius-2)",
        padding: "var(--space-5) var(--space-6)",
      }}
    >
      {/* A plain <style> tag (no client-only CSS-in-JS lib is installed) so
          the tally-fill transition can be a real @media rule — RankTable
          stays a server component, and prefers-reduced-motion still wins. */}
      <style>{`
        .perceev-tally-fill { transition: transform var(--dur-med) var(--ease-out); }
        @media (prefers-reduced-motion: reduce) {
          .perceev-tally-fill { transition: none; }
        }
      `}</style>
      {safeRows.length === 0 && (
        <div
          style={{
            padding: "var(--space-5) 0",
            textAlign: "center",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-3)",
          }}
        >
          No ranked brands yet
        </div>
      )}
      {safeRows.map((row, i) => {
        const isSelf = !!row.isSelf;
        const widthPct = barWidthPct(row.value, maxValue);

        return (
          <div
            key={row.name ?? i}
            data-testid={`rank-row-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-4)",
              padding: "var(--space-3) 0",
              borderBottom: i === safeRows.length - 1 ? "none" : "1px solid var(--border-1)",
            }}
          >
            {/* Rank numeral */}
            <span
              style={{
                flex: "0 0 28px",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                fontSize: "18px",
                lineHeight: 1,
                letterSpacing: "var(--track-data)",
                fontVariantNumeric: "tabular-nums",
                color: isSelf ? "var(--you)" : "var(--text-3)",
                textAlign: "right",
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>

            {/* Name + tally bar */}
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "6px" }}>
                <span
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: "13px",
                    fontWeight: isSelf ? 600 : 500,
                    color: isSelf ? "var(--text-1)" : "var(--text-2)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.name}
                </span>
                {isSelf && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontFamily: "var(--font-display)",
                      fontSize: "9px",
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      color: "var(--you-fg)",
                      background: "var(--you)",
                      borderRadius: "var(--radius-1)",
                      padding: "1px 5px",
                    }}
                  >
                    YOU
                  </span>
                )}
              </div>
              <div
                role="img"
                aria-label={`${row.name}: ${formatPercent(row.value)}`}
                style={{
                  height: "6px",
                  borderRadius: "var(--radius-round)",
                  background: "var(--bg-2)",
                  overflow: "hidden",
                }}
              >
                {/*
                  The tally fills on reveal (DESIGN.md: "tallies counting/filling
                  on reveal"), but it animates `transform: scaleX` rather than
                  `width` — width animation relayouts every frame, while a
                  transform runs on the compositor. The visual is identical: the
                  bar is full-width and scaled from its left edge, and the
                  rounded track above clips the cap.
                */}
                <div
                  className="perceev-tally-fill"
                  style={{
                    height: "100%",
                    width: "100%",
                    transform: `scaleX(${widthPct / 100})`,
                    transformOrigin: "left center",
                    background: isSelf ? "var(--you)" : "var(--border-3)",
                    borderRadius: "var(--radius-round)",
                  }}
                />
              </div>
            </div>

            {/* Value */}
            <span
              style={{
                flex: "0 0 auto",
                width: "56px",
                textAlign: "right",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                fontSize: "16px",
                fontVariantNumeric: "tabular-nums",
                color: "var(--text-1)",
              }}
            >
              {formatPercent(row.value)}
            </span>

            {/* Delta */}
            <div style={{ flex: "0 0 auto", width: "64px", display: "flex", justifyContent: "flex-end" }}>
              <DeltaChip value={row.delta} testId={`rank-row-${i}-delta`} />
            </div>
          </div>
        );
      })}
    </div>
  );
};
