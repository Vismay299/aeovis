"use client";

import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  buildLinePath,
  buildTicks,
  clamp,
  collectTimeDomain,
  createLinearScale,
  dateTimeValue,
  findByDate,
  formatPercent,
  formatShortDate,
  isFiniteNumber,
  nearestPointIndex,
  niceCeil,
  pickTickIndices,
} from "./chartMath";
import { DeltaChip } from "./DeltaChip";

const VIEW_W = 880;
const MARGIN = { top: 20, right: 16, bottom: 30, left: 42 };
const EASE_OUT = [0.22, 1, 0.36, 1]; // mirrors globals.css --ease-out
// Stable (module-level) fallback so a null/undefined series/compareSeries
// prop resolves to the SAME reference on every render — an inline `[]`
// fallback would be a fresh array each render and defeat useMemo below.
const EMPTY_SERIES = [];

/** Keeps the y-axis proportioned to real data (visibility_pct often single digits to low teens) instead of always spanning 0-100. Steps are all multiples of 4 so buildTicks' 4 quarter-divisions land on whole numbers. */
function pickStep(maxVal) {
  if (maxVal <= 8) return 4;
  if (maxVal <= 24) return 8;
  if (maxVal <= 60) return 20;
  return 40;
}

function previousFiniteValue(series, index, metric) {
  for (let i = index - 1; i >= 0; i--) {
    const v = series[i]?.[metric];
    if (isFiniteNumber(v)) return v;
  }
  return null;
}

/**
 * The visibility trend line — the tally the rest of the dashboard is about.
 * Owns its own panel chrome, matching the KpiCard/ScoreBand convention.
 *
 * @param {{date: string, visibility_pct?: number}[]} series your brand's series (real /api/brands/[brand]/metrics shape)
 * @param {{name: string, series: object[], isSelf?: boolean}[]} [compareSeries] rival overlays
 * @param {number} [threshold] draws a dashed white "majority" line at this value
 * @param {string} [metric] which numeric field to read off each point (default "visibility_pct")
 * @param {number} [height]
 * @param {"you"|"accent"|"rival"|"good"|null} [keyline] optional 3px top-edge party-color keyline
 */
export const TrendChart = ({
  series,
  compareSeries,
  threshold = null,
  metric = "visibility_pct",
  height = 280,
  keyline = null,
  testId = "overview-trend",
}) => {
  const safeSeries = Array.isArray(series) ? series : EMPTY_SERIES;
  const safeCompareSeries = Array.isArray(compareSeries) ? compareSeries : EMPTY_SERIES;

  const prefersReduced = useReducedMotion();
  const containerRef = useRef(null);
  const [hoverIdx, setHoverIdx] = useState(null);

  const plotW = VIEW_W - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const { xScale, yScale, selfPoints, comparePointsList, ticksY, tickIdxX } = useMemo(() => {
    const allSeriesForDomain = [safeSeries, ...safeCompareSeries.map((c) => c.series || [])];
    const timeDomain = collectTimeDomain(allSeriesForDomain);
    const xScale = createLinearScale([timeDomain.min, timeDomain.max], [0, plotW]);

    let maxVal = 0;
    for (const p of safeSeries) {
      const v = p?.[metric];
      if (isFiniteNumber(v)) maxVal = Math.max(maxVal, v);
    }
    for (const c of safeCompareSeries) {
      for (const p of c.series || []) {
        const v = p?.[metric];
        if (isFiniteNumber(v)) maxVal = Math.max(maxVal, v);
      }
    }
    if (isFiniteNumber(threshold)) maxVal = Math.max(maxVal, threshold);

    const niceMax = niceCeil(maxVal, pickStep(maxVal));
    const yScale = createLinearScale([0, niceMax], [plotH, 0]);

    const toPoints = (s) =>
      (s || []).map((p) => {
        const t = dateTimeValue(p?.date);
        const v = p?.[metric];
        return {
          x: t == null ? null : xScale(t),
          y: isFiniteNumber(v) ? yScale(v) : null,
          value: isFiniteNumber(v) ? v : null,
        };
      });

    const selfPoints = toPoints(safeSeries);
    const comparePointsList = safeCompareSeries.map((c) => ({
      name: c.name,
      isSelf: !!c.isSelf,
      points: toPoints(c.series),
    }));

    return {
      xScale,
      yScale,
      selfPoints,
      comparePointsList,
      ticksY: buildTicks(niceMax, 5),
      tickIdxX: pickTickIndices(safeSeries.length, 6),
    };
  }, [safeSeries, safeCompareSeries, threshold, metric, plotW, plotH]);

  const validSelfPoints = useMemo(
    () => selfPoints.map((p, i) => ({ ...p, i })).filter((p) => p.x != null && p.y != null),
    [selfPoints]
  );

  const handleMove = (e) => {
    if (validSelfPoints.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const fracX = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const localX = fracX * VIEW_W - MARGIN.left;
    const nearest = nearestPointIndex(
      validSelfPoints.map((p) => p.x),
      localX
    );
    setHoverIdx(nearest === -1 ? null : validSelfPoints[nearest].i);
  };

  const handleLeave = () => setHoverIdx(null);

  const hoverPoint = hoverIdx != null ? selfPoints[hoverIdx] : null;
  const hoverDate = hoverIdx != null ? safeSeries[hoverIdx]?.date : null;
  const hoverPrevValue = hoverIdx != null ? previousFiniteValue(safeSeries, hoverIdx, metric) : null;
  const hoverDelta = hoverPoint?.value != null && hoverPrevValue != null ? hoverPoint.value - hoverPrevValue : null;

  const lastSelf = [...selfPoints].reverse().find((p) => p.y != null) || null;
  const thresholdY = isFiniteNumber(threshold) ? yScale(threshold) : null;
  const selfPath = buildLinePath(selfPoints);
  const isEmpty = safeSeries.length === 0 && safeCompareSeries.every((c) => (c.series || []).length === 0);

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
        padding: "var(--space-6)",
      }}
    >
      {isEmpty ? (
        <div
          style={{
            height: `${height}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-3)",
          }}
        >
          No trend data yet
        </div>
      ) : (
        <div ref={containerRef} style={{ position: "relative" }} onMouseMove={handleMove} onMouseLeave={handleLeave}>
          <svg
            viewBox={`0 0 ${VIEW_W} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
          >
            <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
              {/* Gridlines + y-axis */}
              {ticksY.map((tick) => {
                const y = yScale(tick);
                return (
                  <g key={tick}>
                    <line x1={0} x2={plotW} y1={y} y2={y} stroke="var(--border-1)" strokeWidth={1} />
                    <text
                      x={-8}
                      y={y}
                      textAnchor="end"
                      dominantBaseline="middle"
                      style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "11px", fill: "var(--text-3)" }}
                    >
                      {tick}
                    </text>
                  </g>
                );
              })}

              {/* x-axis dates */}
              {tickIdxX.map((idx) => {
                const p = selfPoints[idx];
                if (!p || p.x == null) return null;
                return (
                  <text
                    key={idx}
                    x={p.x}
                    y={plotH + 20}
                    textAnchor="middle"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fill: "var(--text-3)", letterSpacing: "0.04em" }}
                  >
                    {formatShortDate(safeSeries[idx]?.date)}
                  </text>
                );
              })}

              {/* Threshold line — the majority/visibility threshold, dashed studio white */}
              {thresholdY != null && (
                <>
                  <line
                    x1={0}
                    x2={plotW}
                    y1={thresholdY}
                    y2={thresholdY}
                    stroke="var(--text-1)"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    opacity={0.6}
                  />
                  <text
                    x={plotW}
                    y={thresholdY - 6}
                    textAnchor="end"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "9px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      fill: "var(--text-1)",
                      opacity: 0.7,
                    }}
                  >
                    Threshold
                  </text>
                </>
              )}

              {/* Rival lines */}
              {comparePointsList.map((c, i) => {
                const d = buildLinePath(c.points);
                if (!d) return null;
                const color = c.isSelf ? "var(--you)" : "var(--rival)";
                const strokeOpacity = c.isSelf ? 1 : Math.max(0.4, 0.9 - i * 0.15);
                return (
                  <motion.path
                    key={c.name ?? i}
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeOpacity={strokeOpacity}
                    strokeWidth={c.isSelf ? 2.5 : 1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={prefersReduced ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={prefersReduced ? { duration: 0 } : { duration: 0.7, delay: 0.15 + i * 0.1, ease: EASE_OUT }}
                  />
                );
              })}

              {/* Self line — drawn last so it always reads on top */}
              {selfPath && (
                <motion.path
                  d={selfPath}
                  fill="none"
                  stroke="var(--you)"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={prefersReduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={prefersReduced ? { duration: 0 } : { duration: 0.9, ease: EASE_OUT }}
                />
              )}

              {/* Permanent "current standing" markers at each line's latest point */}
              {comparePointsList.map((c, i) => {
                const last = [...c.points].reverse().find((p) => p.y != null);
                if (!last) return null;
                return (
                  <circle
                    key={`last-${c.name ?? i}`}
                    cx={last.x}
                    cy={last.y}
                    r={3}
                    fill={c.isSelf ? "var(--you)" : "var(--rival)"}
                    opacity={c.isSelf ? 1 : Math.max(0.4, 0.9 - i * 0.15)}
                  />
                );
              })}
              {lastSelf && <circle cx={lastSelf.x} cy={lastSelf.y} r={3.5} fill="var(--you)" />}

              {/* Hover guide + dots */}
              {hoverPoint && hoverPoint.x != null && (
                <>
                  <line x1={hoverPoint.x} x2={hoverPoint.x} y1={0} y2={plotH} stroke="var(--border-2)" strokeWidth={1} />
                  {comparePointsList.map((c, i) => {
                    const originalSeries = safeCompareSeries[i]?.series || [];
                    const matchIdx = originalSeries.findIndex((p) => p?.date === hoverDate);
                    const pt = matchIdx === -1 ? null : c.points[matchIdx];
                    if (!pt || pt.x == null || pt.y == null) return null;
                    return (
                      <circle
                        key={`hoverdot-${c.name ?? i}`}
                        cx={pt.x}
                        cy={pt.y}
                        r={4}
                        fill={c.isSelf ? "var(--you)" : "var(--rival)"}
                        opacity={c.isSelf ? 1 : Math.max(0.4, 0.9 - i * 0.15)}
                        stroke="var(--bg-1)"
                        strokeWidth={1.5}
                      />
                    );
                  })}
                  {hoverPoint.y != null && (
                    <circle cx={hoverPoint.x} cy={hoverPoint.y} r={5} fill="var(--you)" stroke="var(--bg-1)" strokeWidth={2} />
                  )}
                </>
              )}
            </g>
          </svg>

          {/* Tooltip stamp — an HTML overlay (not foreignObject) so type stays
              crisp regardless of the SVG's viewBox scale factor. */}
          {hoverPoint && hoverPoint.x != null && hoverPoint.y != null && (
            <div
              style={{
                position: "absolute",
                left: `${clamp(((MARGIN.left + hoverPoint.x) / VIEW_W) * 100, 8, 92)}%`,
                top: `${((MARGIN.top + hoverPoint.y) / height) * 100}%`,
                transform: "translate(-50%, calc(-100% - 14px))",
                pointerEvents: "none",
                background: "var(--bg-2)",
                border: "1px solid var(--border-2)",
                borderRadius: "var(--radius-1)",
                boxShadow: "var(--shadow-pop)",
                padding: "8px 10px",
                minWidth: "132px",
                zIndex: 2,
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--text-3)",
                  marginBottom: "5px",
                }}
              >
                {formatShortDate(hoverDate)}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    fontFamily: "var(--font-sans)",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "var(--text-1)",
                  }}
                >
                  <span style={{ width: "7px", height: "7px", borderRadius: "2px", background: "var(--you)" }} />
                  You
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 600,
                      fontSize: "14px",
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--text-1)",
                    }}
                  >
                    {formatPercent(hoverPoint.value)}
                  </span>
                  {hoverPrevValue != null && <DeltaChip value={hoverDelta} />}
                </span>
              </div>
              {safeCompareSeries.map((c, i) => {
                const match = findByDate(c.series, hoverDate);
                const v = match?.[metric];
                if (!isFiniteNumber(v)) return null;
                return (
                  <div
                    key={c.name ?? i}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginTop: "4px" }}
                  >
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "5px",
                        fontFamily: "var(--font-sans)",
                        fontSize: "11px",
                        color: "var(--text-2)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "90px",
                      }}
                    >
                      <span
                        style={{
                          width: "7px",
                          height: "7px",
                          borderRadius: "2px",
                          background: c.isSelf ? "var(--you)" : "var(--rival)",
                          opacity: c.isSelf ? 1 : Math.max(0.4, 0.9 - i * 0.15),
                          flexShrink: 0,
                        }}
                      />
                      {c.name}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-display)",
                        fontWeight: 600,
                        fontSize: "13px",
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--text-2)",
                      }}
                    >
                      {formatPercent(v)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
