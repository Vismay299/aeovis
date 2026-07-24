import {
  computeMatrixDomain,
  formatPercent,
  isFiniteNumber,
  neutralRampVar,
  normalize,
  readableOnRamp,
  tealRampOpacity,
} from "./chartMath";

const ENGINE_LABELS = {
  aio: "AIO",
  perplexity: "PPLX",
  chatgpt: "CHATGPT",
  all: "ALL",
};

const engineLabel = (engine) => ENGINE_LABELS[engine] || String(engine).toUpperCase();

const thStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--text-3)",
  padding: "0 var(--space-2) var(--space-2)",
  textAlign: "center",
  whiteSpace: "nowrap",
};

/**
 * Brands x engines heatmap. CRITICAL RULE (DESIGN.md): teal and red are ROLE
 * colors, never magnitude scales. So the self row's cells encode magnitude
 * with a teal-INTENSITY ramp (opacity of a `--you` fill, faint -> full),
 * and every rival row encodes magnitude with a NEUTRAL luminance ramp
 * (graphite steps from --bg-2/3 up to --text-2) — never red. Both ramps
 * share one normalized domain (computeMatrixDomain over every cell) so a
 * rival's strong cell and your strong cell read as equally "strong," just
 * in different hues.
 *
 * Owns its own panel chrome (background, hairline border, sharp corners),
 * matching the KpiCard/ScoreBand convention. The table scrolls horizontally
 * inside its own container on a narrow viewport rather than the page.
 *
 * @param {string[]} brands
 * @param {string[]} engines
 * @param {Record<string, Record<string, number|null>>} values  {[brand]: {[engine]: pct}}
 * @param {string} selfBrand
 * @param {"you"|"accent"|"rival"|"good"|null} [keyline] optional 3px top-edge party-color keyline
 */
export const PerformanceMatrix = ({ brands, engines, values, selfBrand, keyline = null, testId = "perf-matrix" }) => {
  const safeBrands = Array.isArray(brands) ? brands : [];
  const safeEngines = Array.isArray(engines) ? engines : [];
  const safeValues = values && typeof values === "object" ? values : {};
  const domain = computeMatrixDomain(safeValues);

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
        overflowX: "auto",
      }}
    >
      {(safeBrands.length === 0 || safeEngines.length === 0) && (
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
          No engine coverage yet
        </div>
      )}
      {safeBrands.length > 0 && safeEngines.length > 0 && (
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: `${180 + safeEngines.length * 90}px` }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: "left" }}>Brand</th>
            {safeEngines.map((engine) => (
              <th key={engine} style={thStyle}>
                {engineLabel(engine)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {safeBrands.map((brand, rowIdx) => {
            const isSelfRow = brand === selfBrand;
            return (
              <tr key={brand}>
                <td
                  style={{
                    padding: "var(--space-2) var(--space-3) var(--space-2) 0",
                    borderTop: "1px solid var(--border-1)",
                    background: isSelfRow ? "var(--you-soft)" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <span
                      style={{
                        fontFamily: "var(--font-sans)",
                        fontSize: "13px",
                        fontWeight: isSelfRow ? 600 : 500,
                        color: isSelfRow ? "var(--text-1)" : "var(--text-2)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {brand}
                    </span>
                    {isSelfRow && (
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
                </td>
                {safeEngines.map((engine) => {
                  const value = safeValues?.[brand]?.[engine];
                  const finite = isFiniteNumber(value);
                  const t = finite ? normalize(value, domain.min, domain.max) : null;
                  const dark = finite && readableOnRamp(t);

                  let fill = "var(--bg-1)";
                  let overlayOpacity = null;
                  if (finite) {
                    if (isSelfRow) {
                      fill = "var(--bg-1)";
                      overlayOpacity = tealRampOpacity(t);
                    } else {
                      fill = neutralRampVar(t);
                    }
                  }

                  const textColor = !finite ? "var(--text-3)" : dark ? (isSelfRow ? "var(--you-fg)" : "var(--text-inverse)") : "var(--text-1)";

                  return (
                    <td
                      key={engine}
                      data-testid={`perf-cell-${rowIdx}-${engine}`}
                      style={{
                        borderTop: "1px solid var(--border-1)",
                        borderLeft: "1px solid var(--border-1)",
                        padding: 0,
                        textAlign: "center",
                      }}
                    >
                      <div style={{ position: "relative", padding: "10px 8px", background: fill }}>
                        {overlayOpacity != null && (
                          <div
                            aria-hidden="true"
                            style={{
                              position: "absolute",
                              inset: 0,
                              background: "var(--you)",
                              opacity: overlayOpacity,
                            }}
                          />
                        )}
                        <span
                          style={{
                            position: "relative",
                            fontFamily: "var(--font-display)",
                            fontWeight: 600,
                            fontSize: "15px",
                            fontVariantNumeric: "tabular-nums",
                            color: textColor,
                          }}
                        >
                          {finite ? formatPercent(value) : "—"}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      )}
    </div>
  );
};
