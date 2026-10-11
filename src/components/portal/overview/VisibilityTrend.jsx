"use client";

/**
 * Visibility over time. The line and area are inline SVG on a 0–100 grid that
 * stretches to the card width; the gridline labels, dots and dates are HTML so
 * they keep their size on phones.
 */

import { useId } from "react";
import { Card, EmptyState, ProgressBar, Skeleton, formatPct } from "../ui";
import { TrendingUp } from "lucide-react";
import { engineLabel, scanSeries, shortDate, toNumber } from "./overviewModel";
import "./overview.css";

const GRID = [100, 75, 50, 25, 0];

function Chart({ points }) {
  const gradientId = `pv-overview-area-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const count = points.length;
  const xAt = (i) => (count === 1 ? 50 : (i / (count - 1)) * 100);
  const yAt = (value) => 100 - value;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yAt(p.visibility).toFixed(2)}`).join(" ");
  const area = `${line} L${xAt(count - 1).toFixed(2)},100 L${xAt(0).toFixed(2)},100 Z`;
  const first = points[0];
  const last = points[count - 1];
  const summary = points.map((p) => `${shortDate(p.at)}: ${formatPct(p.visibility)}`).join(", ");

  return (
    <div className="pv-overview-chart">
      <div className="pv-overview-chart__y" aria-hidden="true">
        {GRID.map((g) => (
          <span key={g} style={{ top: `${100 - g}%` }}>{g}%</span>
        ))}
      </div>
      <div className="pv-overview-chart__plot">
        <svg className="pv-overview-chart__svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby={`${gradientId}-title`}>
          <title id={`${gradientId}-title`}>{`AI visibility by scan. ${summary}.`}</title>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="pv-overview-chart__area-top" />
              <stop offset="100%" className="pv-overview-chart__area-bottom" />
            </linearGradient>
          </defs>
          {GRID.map((g) => (
            <line key={g} className="pv-overview-chart__grid" x1="0" x2="100" y1={yAt(g)} y2={yAt(g)} />
          ))}
          <path className="pv-overview-chart__area" d={area} fill={`url(#${gradientId})`} />
          <path className="pv-overview-chart__line" d={line} />
        </svg>
        {points.map((p, i) => (
          <span
            key={`${p.id || i}`}
            className={`pv-overview-chart__dot${i === count - 1 ? " is-last" : ""}`}
            style={{ left: `${xAt(i)}%`, top: `${yAt(p.visibility)}%` }}
            aria-hidden="true"
          />
        ))}
        <span
          className="pv-overview-chart__tag"
          style={{ left: `${xAt(count - 1)}%`, top: `${yAt(last.visibility)}%` }}
          aria-hidden="true"
        >
          {formatPct(last.visibility)}
        </span>
      </div>
      <div className="pv-overview-chart__x" aria-hidden="true">
        <span>{shortDate(first.at)}</span>
        <span>{shortDate(last.at)}</span>
      </div>
    </div>
  );
}

function ByEngine({ metrics }) {
  const rows = (metrics || []).filter((row) => row && row.date);
  if (!rows.length) return null;
  const latestDate = rows.reduce((max, row) => (String(row.date) > max ? String(row.date) : max), "");
  const engines = rows
    .filter((row) => String(row.date) === latestDate && toNumber(row.visibility_pct) !== null)
    .map((row) => ({ engine: row.engine, value: toNumber(row.visibility_pct) }))
    .sort((a, b) => b.value - a.value);
  if (!engines.length) return null;

  return (
    <div className="pv-overview-engines">
      <h3 className="pv-overview-engines__title">By engine</h3>
      {engines.map((item) => (
        <div key={item.engine} className="pv-overview-engine">
          <span className="pv-overview-engine__name">{engineLabel(item.engine)}</span>
          <ProgressBar value={item.value} size="sm" label={`${engineLabel(item.engine)} visibility`} />
          <span className="pv-overview-engine__value">{formatPct(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function VisibilityTrend({ overview }) {
  const loading = !overview;
  const points = loading ? [] : scanSeries(overview.scans);

  return (
    <Card title="Visibility over time" description="Share of tracked questions where AI engines named you">
      {loading ? (
        <Skeleton height={200} />
      ) : points.length < 2 ? (
        <EmptyState icon={TrendingUp} title="Your trend appears after your second scan">
          Each scan asks the same questions again, so the change over time becomes visible from the second run.
        </EmptyState>
      ) : (
        <Chart points={points} />
      )}
      {loading ? null : <ByEngine metrics={overview.metrics} />}
    </Card>
  );
}
