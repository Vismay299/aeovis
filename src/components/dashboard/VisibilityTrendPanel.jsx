import { TrendChart, DeltaChip } from "@/components/perceev/charts";
import { formatPercent, isFiniteNumber } from "@/components/perceev/charts/chartMath";
import { Skeleton } from "@/components/perceev/Skeleton";
import { SectionStrap } from "./SectionStrap";
import { comparableVisibilityTail } from "@/shared/analytics/visibilitySeries";

/**
 * Overview's "Visibility Trend" block (P1.4). Wraps the finished TrendChart
 * against the real `/api/brands/[brand]/metrics` series — the fetch itself
 * lives one level up in OverviewAnalytics (single network call shared with
 * the rank board's self-delta enrichment), so this component is pure
 * presentation over the `metrics` state machine it's handed.
 *
 * Insufficient history is the COMMON case (most brands have 1-2 scans so
 * far), not an edge case, so it gets a real explanation rather than a bare
 * "no data" box — and the current value still renders even without a chart,
 * sourced from the metrics endpoint when available and falling back to this
 * scan's own hero score (always present, no fetch required) so the number
 * never blocks on the network.
 *
 * @param {{status: "loading"|"ready"|"error", series?: object[], summary?: object}} metrics
 * @param {number} heroScore this scan's own headline visibility (fallback source for "current value")
 */
export const VisibilityTrendPanel = ({ metrics, heroScore }) => {
  const status = metrics?.status || "loading";
  const summary = status === "ready" ? metrics.summary : null;
  const series = status === "ready" && Array.isArray(metrics.series) ? metrics.series : [];

  // Prefer the metrics endpoint's own latest point (the same number the
  // chart plots). An explicitly withheld latest reading stays unknown; the
  // scan's hero is a fallback only before history is loaded or when it is empty.
  const currentValue = status === "ready" && series.length > 0
    ? isFiniteNumber(summary?.latest_visibility_pct) ? summary.latest_visibility_pct : null
    : isFiniteNumber(heroScore) ? heroScore : null;

  const chartSeries = comparableVisibilityTail(series);
  const hasTrend = status === "ready" && chartSeries.length >= 2;
  const showEmptyState = status === "error" || (status === "ready" && !hasTrend);
  const explanation = series.at(-1)?.metric_state === "legacy_unknown"
    ? "This historical value is retained, but its qualification is unknown."
    : summary?.comparison?.comparable === false && series.length >= 2
      ? summary.comparison.detail : null;

  return (
    <div data-testid="trend-panel">
      <SectionStrap testId="trend-strap">Visibility Trend</SectionStrap>

      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)", marginBottom: "var(--space-4)", flexWrap: "wrap" }}>
        <span
          data-testid="trend-current-value"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "32px",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1,
            color: "var(--text-1)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {currentValue != null ? formatPercent(currentValue) : "—"}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--text-3)",
          }}
        >
          Current visibility
        </span>
        {status !== "loading" && <DeltaChip value={summary?.delta_visibility_pct} testId="trend-delta-chip" />}
      </div>

      {status === "loading" && <Skeleton style={{ height: "280px", borderRadius: "var(--radius-2)" }} />}

      {explanation && <p role="status" data-testid="trend-comparison-boundary">{explanation}</p>}
      {hasTrend && <TrendChart series={chartSeries} keyline="you" />}

      {showEmptyState && (
        <div
          data-testid="trend-empty-state"
          style={{
            background: "var(--bg-1)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--radius-2)",
            padding: "var(--space-8) var(--space-7)",
            textAlign: "center",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "14px",
              color: "var(--text-2)",
              lineHeight: 1.55,
              maxWidth: "440px",
              margin: "0 auto",
            }}
          >
            {status === "error"
              ? "Trend history is temporarily unavailable — your latest scan value is shown above."
              : "Not enough comparable qualified readings yet to chart a trend."}
          </p>
        </div>
      )}
    </div>
  );
};
