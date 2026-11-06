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
    <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-2.5 pt-6">
      <div className="relative h-[200px]" aria-hidden="true">
        {GRID.map((g) => (
          <span key={g} className="absolute right-0 text-[11.5px] tabular-nums text-muted-foreground -translate-y-1/2" style={{ top: `${100 - g}%` }}>{g}%</span>
        ))}
      </div>
      <div className="relative h-[200px] mr-2.5">
        <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby={`${gradientId}-title`}>
          <title id={`${gradientId}-title`}>{`AI visibility by scan. ${summary}.`}</title>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {GRID.map((g) => (
            <line key={g} className="stroke-border stroke-1 [vector-effect:non-scaling-stroke]" x1="0" x2="100" y1={yAt(g)} y2={yAt(g)} />
          ))}
          <path d={area} fill={`url(#${gradientId})`} />
          <path className="fill-none stroke-primary stroke-2 stroke-round stroke-cap-round [vector-effect:non-scaling-stroke]" d={line} />
        </svg>
        {points.map((p, i) => (
          <span
            key={`${p.id || i}`}
            className={`absolute rounded-full border-2 border-primary bg-background -translate-x-1/2 -translate-y-1/2 ${i === count - 1 ? "size-3 bg-primary" : "size-2.5"}`}
            style={{ left: `${xAt(i)}%`, top: `${yAt(p.visibility)}%` }}
            aria-hidden="true"
          />
        ))}
        <span
          className="absolute rounded-md border border-border bg-background px-1.5 py-0.5 text-xs font-semibold tabular-nums text-foreground -translate-x-1/2 -translate-y-full"
          style={{ left: `${xAt(count - 1)}%`, top: `${yAt(last.visibility)}%` }}
          aria-hidden="true"
        >
          {formatPct(last.visibility)}
        </span>
      </div>
      <div className="col-start-2 flex justify-between gap-2 mt-2.5 mr-2.5 text-[11.5px] tabular-nums text-muted-foreground" aria-hidden="true">
        <span>{shortDate(first.at)}</span>
        <span>{shortDate(last.at)}</span>
      </div>
    </div>
  );
}

function ByEngine({ metrics }) {
  const rows = (Array.isArray(metrics) ? metrics : []).filter((row) => row && row.date);
  if (!rows.length) return null;
  const latestDate = rows.reduce((max, row) => (String(row.date) > max ? String(row.date) : max), "");
  const engines = rows
    .filter((row) => String(row.date) === latestDate && toNumber(row.visibility_pct) !== null)
    .map((row) => ({ engine: row.engine, value: toNumber(row.visibility_pct) }))
    .sort((a, b) => b.value - a.value);
  if (!engines.length) return null;

  return (
    <div className="grid gap-3 mt-5 pt-4 border-t border-border">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By engine</h3>
      {engines.map((item) => (
        <div key={item.engine} className="flex items-center gap-3">
          <span className="w-40 text-sm text-foreground truncate">{engineLabel(item.engine)}</span>
          <div className="flex-1"><ProgressBar value={item.value} size="sm" label={`${engineLabel(item.engine)} visibility`} /></div>
          <span className="w-12 text-right text-sm font-medium tabular-nums text-foreground">{formatPct(item.value)}</span>
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
