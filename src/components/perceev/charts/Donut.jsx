"use client";

import { motion, useReducedMotion } from "framer-motion";
import { buildDonutSegments, describeArcPath, formatPercent, neutralRampVar } from "./chartMath";

const SIZE = 200;
const CENTER = SIZE / 2;
const R_OUTER = 86;
const THICKNESS = 26;
const RADIUS = R_OUTER - THICKNESS / 2;

/** Largest rival gets the brightest neutral step, smallest fades toward the dark end — never red. Floor lifted so even a trailing rival stays visible against the panel. */
function rivalRampT(rank, total) {
  if (total <= 1) return 1;
  const raw = 1 - rank / (total - 1);
  return 0.15 + raw * 0.85;
}

/**
 * Share-of-voice ring. Self segment is `--you`; every rival is a distinct
 * step of the neutral graphite ramp (DESIGN.md: rivals never all read as
 * red magnitude — that's an alarm color, not a rank). Center shows the
 * self segment's normalized share (falls back to the first segment) so the
 * printed number always matches the wedge you're looking at, even if the
 * input values don't already sum to 100.
 *
 * Owns its own panel chrome (background, hairline border, sharp corners),
 * matching the KpiCard/ScoreBand convention.
 *
 * @param {{name: string, value: number, isSelf?: boolean}[]} segments
 * @param {"you"|"accent"|"rival"|"good"|null} [keyline] optional 3px top-edge party-color keyline
 */
export const Donut = ({
  segments,
  centerLabel = "Share of Voice",
  showLegend = true,
  keyline = null,
  testId = "sov-donut",
}) => {
  const safeSegments = Array.isArray(segments) ? segments : [];
  const prefersReduced = useReducedMotion();
  const n = safeSegments.length;
  const geo = buildDonutSegments(safeSegments, { gapDeg: n > 1 ? 2 : 0 });
  const hasData = geo.some((s) => s.pct > 0);

  const rivalsByValue = geo
    .filter((s) => !s.isSelf)
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((s) => s.name);

  const centerSeg = geo.find((s) => s.isSelf) || geo[0];
  const centerText = hasData && centerSeg ? formatPercent(centerSeg.pct * 100) : "—";

  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-5)",
        background: "var(--bg-1)",
        borderTop: keyline ? `3px solid var(--${keyline})` : "1px solid var(--border-1)",
        borderRight: "1px solid var(--border-1)",
        borderBottom: "1px solid var(--border-1)",
        borderLeft: "1px solid var(--border-1)",
        borderRadius: "var(--radius-2)",
        padding: "var(--space-6)",
      }}
    >
      <div style={{ position: "relative", width: "100%", maxWidth: `${SIZE}px` }}>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ width: "100%", height: "auto", display: "block" }}>
          {/* Track — makes the segment gaps read as design, not missing data */}
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="var(--bg-2)" strokeWidth={THICKNESS} />

          {!hasData && (
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke="var(--border-2)"
              strokeWidth={THICKNESS}
              strokeDasharray="3 5"
            />
          )}

          {hasData &&
            geo.map((seg, i) => {
              if (seg.pct <= 0) return null;
              const color = seg.isSelf
                ? "var(--you)"
                : neutralRampVar(rivalRampT(rivalsByValue.indexOf(seg.name), rivalsByValue.length));
              const d = describeArcPath(CENTER, CENTER, RADIUS, seg.startAngle, seg.endAngle);

              return (
                <motion.path
                  key={seg.name ?? i}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={THICKNESS}
                  strokeLinecap="butt"
                  initial={prefersReduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={
                    prefersReduced ? { duration: 0 } : { duration: 0.8, delay: i * 0.09, ease: [0.22, 1, 0.36, 1] }
                  }
                />
              );
            })}
        </svg>

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: "40px",
              lineHeight: 1,
              letterSpacing: "var(--track-data)",
              fontVariantNumeric: "tabular-nums",
              color: "var(--text-1)",
            }}
          >
            {centerText}
          </span>
          <span
            style={{
              marginTop: "6px",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--text-3)",
              textAlign: "center",
            }}
          >
            {centerLabel}
          </span>
        </div>
      </div>

      {showLegend && (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "var(--space-2) var(--space-5)", width: "100%" }}>
          {geo.map((seg, i) => {
            const color = seg.isSelf
              ? "var(--you)"
              : neutralRampVar(rivalRampT(rivalsByValue.indexOf(seg.name), rivalsByValue.length));
            return (
              <div key={seg.name ?? i} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ width: "8px", height: "8px", flexShrink: 0, borderRadius: "1px", background: color }} />
                <span
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: "12px",
                    fontWeight: seg.isSelf ? 600 : 400,
                    color: seg.isSelf ? "var(--text-1)" : "var(--text-2)",
                  }}
                >
                  {seg.name}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "12px",
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-3)",
                  }}
                >
                  {formatPercent(seg.pct * 100)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
