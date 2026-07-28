import { formatPercent } from "./chartMath";
import { DeltaChip } from "./DeltaChip";

/**
 * The occupancy board.
 *
 * Who holds how much of the line, in the order given (the rank numeral is
 * the array index + 1, so callers control ranking). Share reads as discrete
 * lit sections rather than a smooth bar, because a track circuit is either
 * held or clear — that is the unit the product actually measures.
 *
 * @param {{name: string, value: number, delta?: number|null, isSelf?: boolean}[]} rows
 */
export const RankTable = ({ rows, keyline = null, testId = "rank-table" }) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  const maxValue = safeRows.reduce(
    (m, r) => (typeof r.value === "number" && r.value > m ? r.value : m),
    0,
  );
  const SECTIONS = 20;

  return (
    <div
      data-testid={testId}
      className="sb-panel"
      style={{
        borderTop: keyline ? `2px solid var(--lamp-${keyline})` : undefined,
        padding: "var(--space-4) var(--space-5) var(--space-5)",
      }}
    >
      {safeRows.length === 0 && (
        <div className="t-plate" style={{ padding: "var(--space-5) 0", textAlign: "center" }}>
          no ranked brands yet
        </div>
      )}

      {safeRows.map((row, i) => {
        const isSelf = !!row.isSelf;
        const ratio = maxValue > 0 ? Math.max(0, Math.min(1, row.value / maxValue)) : 0;
        const held = Math.round(ratio * SECTIONS);

        return (
          <div
            key={`${row.name ?? "row"}-${i}`}
            data-testid={`rank-row-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-4)",
              padding: "var(--space-3) 0",
              borderBottom: i === safeRows.length - 1 ? "none" : "1px solid var(--rule-1)",
            }}
          >
            <span
              className="t-tally"
              style={{
                flex: "0 0 26px",
                fontSize: "15px",
                lineHeight: 1,
                color: isSelf ? "var(--lamp-white)" : "var(--text-3)",
                textAlign: "right",
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>

            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "6px" }}>
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: isSelf ? 700 : 450,
                    color: isSelf ? "var(--text-1)" : "var(--text-2)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.name}
                </span>
                {isSelf && <span className="t-plate" style={{ color: "var(--lamp-white)" }}>you</span>}
              </div>

              {/* discrete sections: held or clear, never a smooth fill */}
              <div
                role="img"
                aria-label={`${row.name}: ${formatPercent(row.value)}`}
                style={{ display: "flex", gap: "2px" }}
              >
                {Array.from({ length: SECTIONS }).map((_, s) => (
                  <span
                    key={s}
                    style={{
                      flex: 1,
                      height: "7px",
                      borderRadius: "1px",
                      background:
                        s < held
                          ? isSelf
                            ? "var(--lamp-white)"
                            : "var(--steel-4)"
                          : "var(--panel-3)",
                    }}
                  />
                ))}
              </div>
            </div>

            <span
              className="t-tally"
              style={{
                flex: "0 0 auto",
                width: "54px",
                textAlign: "right",
                fontSize: "15px",
                color: "var(--text-1)",
              }}
            >
              {formatPercent(row.value)}
            </span>

            <div style={{ flex: "0 0 auto", width: "60px", display: "flex", justifyContent: "flex-end" }}>
              <DeltaChip value={row.delta} testId={`rank-row-${i}-delta`} />
            </div>
          </div>
        );
      })}
    </div>
  );
};
