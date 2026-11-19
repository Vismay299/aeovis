"use client";

/**
 * @author: @dorianbaffier
 * @description: Metric Card
 * @version: 2.0.0
 * @date: 2026-10-17
 * @license: MIT
 * @website: https://kokonutui.com
 * @github: https://github.com/kokonut-labs/kokonutui
 */

// Perceev edit (T9): adapted to sparse, honestly-unknown scan data.
// - A day's value can be null (no scan). Nulls are gaps: no line through them,
//   left out of every average, and read as "No scan".
// - The headline is the average per scan over the read, not a sum, so a period
//   with more scans does not look like more mentions. Captions name how many
//   scans each side of a comparison holds, and no delta is shown when either
//   side has none.
// - Built-in demo data and events are gone; `data` is required. The UI lab
//   passes its own sample.
// - Segments may overlap (per-engine counts of a blended total), so the
//   breakdown lists each one's average without a share bar or percentages.
// - The period morph is removed: it resampled every period to one length,
//   which would draw lines through the gaps. Lines draw straight to the new
//   shape instead.
// - Colours use the app's tokens instead of zinc / white.

import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/shared/utils";

// The chart's drawing box; it stretches to the card's width.
const W = 400;
const H = 120;
const PAD_Y = 10;
const DAY = 86_400_000;
const DIGIT = /\d/;
const SNAP_PX = 6;
// A pointer this close to a scan day reads that day instead of an empty one.
const SCAN_SNAP_PX = 14;
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export interface MetricPoint {
  /** YYYY-MM-DD */
  date: string;
  /** The metric that day, or null when nothing was measured. */
  value: number | null;
  /** One value per segment, in the order of `segments`; null when unknown. */
  parts?: (number | null)[];
}

export interface MetricEvent {
  /** YYYY-MM-DD */
  date: string;
  label: string;
}

export interface MetricCardProps {
  label: string;
  /** Names of the parts charted one at a time. They may overlap. */
  segments?: string[];
  /** One point per calendar day, oldest first. Days without a scan are null. */
  data: MetricPoint[];
  /** Days worth a note. Pinned on the chart. */
  events?: MetricEvent[];
  periods?: number[];
  defaultPeriod?: number;
  /** A line under the breakdown heading. */
  breakdownNote?: string;
  className?: string;
}

interface Span {
  lo: number;
  hi: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const known = (values: (number | null)[]) =>
  values.filter((v): v is number => v !== null);

/** Average of the known values, or null when there are none. */
function mean(values: (number | null)[]) {
  const real = known(values);
  return real.length ? real.reduce((s, v) => s + v, 0) / real.length : null;
}

const scans = (n: number) => `${n} scan${n === 1 ? "" : "s"}`;

const formatDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const formatShort = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const shiftDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);

const yOf = (height: number) => PAD_Y + (1 - height) * (H - PAD_Y * 2);

/** Points to an SVG path, smoothed with a Catmull-Rom spline. */
function toPath(pts: [number, number][]) {
  if (pts.length === 0) {
    return "";
  }
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

/**
 * One path per run of consecutive known days, so a gap breaks the line. A run
 * of one day draws nothing here; its dot marks it.
 */
function runsOf(values: (number | null)[], norm: (v: number) => number) {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  const last = Math.max(1, values.length - 1);
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) {
        runs.push(run);
      }
      run = [];
      return;
    }
    run.push([(i / last) * W, yOf(norm(v))]);
  });
  if (run.length) {
    runs.push(run);
  }
  return runs.filter((r) => r.length > 1);
}

const linePath = (runs: [number, number][][]) => runs.map(toPath).join("");

/** Each run closed down to the baseline. */
const areaPath = (runs: [number, number][][]) =>
  runs
    .map(
      (r) =>
        `${toPath(r)}L${r.at(-1)?.[0].toFixed(2)} ${H}L${r[0][0].toFixed(2)} ${H}Z`
    )
    .join("");

/**
 * The last `days` points, padded at the front with unknown days when the data
 * is shorter, so index i of a period and of the one before line up.
 */
function windowOf(data: MetricPoint[], end: number, days: number) {
  const out: MetricPoint[] = [];
  const lastDate = data.at(-1)?.date;
  for (let i = end - days; i < end; i++) {
    const point = i >= 0 ? data[i] : undefined;
    if (point) {
      out.push(point);
    } else {
      const date = lastDate
        ? shiftDay(lastDate, i - (data.length - 1))
        : "1970-01-01";
      out.push({ date, value: null });
    }
  }
  return out;
}

/** One period's numbers and its shape, for the whole metric or one segment. */
function buildPeriod(data: MetricPoint[], days: number, focus: number | null) {
  const current = windowOf(data, data.length, days);
  const previous = windowOf(data, data.length - days, days);
  const pick = (p: MetricPoint) =>
    focus === null ? p.value : (p.parts?.[focus] ?? null);
  const now = current.map(pick);
  const before = previous.map(pick);
  // From zero, so a small change does not fill the chart's height.
  const hi = Math.max(0, ...known(now), ...known(before)) * 1.1 || 1;
  const norm = (v: number) => v / hi;
  const nowRuns = runsOf(now, norm);
  return {
    current,
    previous,
    now,
    before,
    paths: {
      current: linePath(nowRuns),
      area: areaPath(nowRuns),
      previous: linePath(runsOf(before, norm)),
    },
    norm,
  };
}

/** Each segment's average over a span of days, or all of them. */
function breakdown(points: MetricPoint[], span: Span | null, count: number) {
  const days = span ? points.slice(span.lo, span.hi + 1) : points;
  return Array.from({ length: count }, (_, i) =>
    mean(days.map((p) => p.parts?.[i] ?? null))
  );
}

/** Each digit rolls on its own wheel; separators sit still. */
function RollingNumber({ value }: { value: string }) {
  const chars = value.split("");
  return (
    <span aria-hidden className="inline-flex tabular-nums">
      {chars.map((char, i) => {
        // Keyed from the right, so units stay put when the length changes.
        const key = chars.length - i;
        if (!DIGIT.test(char)) {
          return <span key={`s${key}`}>{char}</span>;
        }
        return (
          <span
            className="relative inline-block h-[1em] overflow-hidden leading-none"
            key={`d${key}`}
          >
            <span className="invisible">0</span>
            <span
              className="absolute inset-x-0 top-0 flex flex-col transition-transform duration-[380ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
              style={{ transform: `translateY(-${Number(char) * 10}%)` }}
            >
              {DIGITS.map((d) => (
                <span className="block h-[1em] leading-none" key={d}>
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

type Period = ReturnType<typeof buildPeriod>;

/** A range once the drag covers two days or more, else the cursor's day. */
function spanOf(
  range: { a: number; b: number } | null,
  cursor: number | null,
  last: number
): { span: Span | null; ranged: boolean } {
  if (range && range.a !== range.b) {
    return {
      span: { lo: Math.min(range.a, range.b), hi: Math.max(range.a, range.b) },
      ranged: true,
    };
  }
  if (cursor !== null && cursor <= last) {
    return { span: { lo: cursor, hi: cursor }, ranged: false };
  }
  return { span: null, ranged: false };
}

/**
 * What the card reads: a range, one day, or the whole period. `delta` is null
 * whenever either side has no scan to compare.
 */
function readOf(
  info: Period,
  span: Span | null,
  ranged: boolean,
  period: number,
  events: MetricEvent[]
) {
  const slice = (values: (number | null)[]) =>
    span ? values.slice(span.lo, span.hi + 1) : values;
  const nowValues = slice(info.now);
  const beforeValues = slice(info.before);
  const value = mean(nowValues);
  const compare = mean(beforeValues);
  const count = known(nowValues).length;
  const priorCount = known(beforeValues).length;
  const day = span && !ranged ? info.current[span.lo] : undefined;
  const twin = span && !ranged ? info.previous[span.lo] : undefined;
  const event = day ? events.find((e) => e.date === day.date) : undefined;

  let caption: string;
  let comparison: string | null = null;
  if (day) {
    caption =
      value === null ? `${formatDay(day.date)} · No scan` : formatDay(day.date);
    if (twin && compare !== null) {
      comparison = `vs ${formatShort(twin.date)}`;
    }
  } else if (ranged && span) {
    const from = formatShort(info.current[span.lo].date);
    const to = formatShort(info.current[span.hi].date);
    caption =
      count === 0
        ? `${from} – ${to} · No scans`
        : `${from} – ${to} · avg of ${scans(count)}`;
    if (priorCount) {
      comparison = `vs ${priorCount} before`;
    }
  } else {
    caption =
      count === 0
        ? `No scans in the last ${period} days`
        : `Avg of ${scans(count)} in ${period} days`;
    if (count) {
      comparison = priorCount
        ? `vs ${priorCount} in the ${period} before`
        : "none before to compare";
    }
  }

  // A change needs a scan on both sides. From zero there is no percentage.
  let change: { text: string; tone: "up" | "down" | "flat" } | null = null;
  if (value !== null && compare !== null) {
    if (compare === 0) {
      change =
        value === 0
          ? { text: "No change", tone: "flat" }
          : { text: "▲ from 0", tone: "up" };
    } else {
      const delta = (value - compare) / compare;
      change = {
        text: `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta * 100).toFixed(1)}%`,
        tone: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
      };
    }
  } else if (comparison?.startsWith("vs ")) {
    comparison = null;
  }
  return { day, twin, value, change, event, caption, comparison };
}

/** Each segment's average over what the card reads. Pick one to chart it alone. */
function Breakdown({
  segments,
  parts,
  focus,
  label,
  note,
  format,
  onChoose,
}: {
  segments: string[];
  parts: (number | null)[];
  focus: number | null;
  label: string;
  note?: string;
  format: (value: number | null) => string;
  onChoose: (index: number) => void;
}) {
  return (
    <div className="mt-4 border-border border-t pt-4">
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
      <ul className="-mx-2 mt-1.5">
        {segments.map((name, i) => (
          <li key={name}>
            <button
              aria-label={
                focus === i ? `Show all of ${label}` : `Show only ${name}`
              }
              aria-pressed={focus === i}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-[background-color,opacity] duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                focus === i && "bg-muted",
                focus !== null && focus !== i && "opacity-50"
              )}
              onClick={() => onChoose(i)}
              type="button"
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  focus === i ? "bg-primary" : "bg-muted-foreground/40"
                )}
              />
              <span className="flex-1 truncate text-muted-foreground">
                {name}
              </span>
              <span className="font-medium tabular-nums">
                {format(parts[i] ?? null)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Arrow keys step between scan days; Home and End jump to the first and last. */
function keyTarget(key: string, from: number, scanDays: number[]) {
  if (scanDays.length === 0) {
    return undefined;
  }
  switch (key) {
    case "ArrowLeft":
      return [...scanDays].reverse().find((i) => i < from) ?? from;
    case "ArrowRight":
      return scanDays.find((i) => i > from) ?? from;
    case "Home":
      return scanDays[0];
    case "End":
      return scanDays.at(-1);
    default:
      return undefined;
  }
}

export default function MetricCard({
  label,
  segments = [],
  data,
  events = [],
  periods = [7, 30, 90],
  defaultPeriod = 30,
  breakdownNote,
  className,
}: MetricCardProps) {
  const clipId = `${useId().replace(/:/g, "")}-lit`;
  const [period, setPeriod] = useState(defaultPeriod);
  const [focus, setFocus] = useState<number | null>(null);
  // The day under the pointer or keyboard cursor.
  const [cursor, setCursor] = useState<number | null>(null);
  // A pinned range: where the drag began and where it is now.
  const [range, setRange] = useState<{ a: number; b: number } | null>(null);
  const drag = useRef<number | null>(null);
  const info = useMemo(
    () => buildPeriod(data, period, focus),
    [data, period, focus]
  );
  const chartRef = useRef<HTMLDivElement>(null);

  const number = useMemo(
    () => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }),
    []
  );
  const format = useCallback(
    (v: number | null) => (v === null ? "—" : number.format(v)),
    [number]
  );

  const last = info.current.length - 1;
  const scanDays = useMemo(
    () =>
      info.now.flatMap((v, i) => (v === null ? [] : [i])),
    [info.now]
  );

  // Scans per period, so each period button can say how much it holds.
  const scansIn = useMemo(
    () =>
      Object.fromEntries(
        periods.map((days) => [
          days,
          known(data.slice(-days).map((p) => p.value)).length,
        ])
      ),
    [data, periods]
  );

  const pinned = useMemo(
    () =>
      events
        .map((e) => ({
          ...e,
          at: info.current.findIndex((p) => p.date === e.date),
        }))
        .filter((e) => e.at >= 0),
    [events, info]
  );

  const indexAt = useCallback(
    (clientX: number) => {
      const rect = chartRef.current?.getBoundingClientRect();
      if (!rect) {
        return 0;
      }
      const t = clamp((clientX - rect.left) / rect.width, 0, 1);
      const px = (i: number) => Math.abs((i / (last || 1) - t) * rect.width);
      // Pinned days pull the cursor in, so their notes are easy to land on.
      const near = pinned.find((e) => px(e.at) < SNAP_PX);
      if (near) {
        return near.at;
      }
      // So do scan days: most days have none, and a scan is what you want.
      let best: number | null = null;
      for (const i of scanDays) {
        if (px(i) < SCAN_SNAP_PX && (best === null || px(i) < px(best))) {
          best = i;
        }
      }
      return best ?? Math.round(t * last);
    },
    [last, pinned, scanDays]
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = indexAt(event.clientX);
    drag.current = at;
    setRange(null);
    setCursor(at);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = indexAt(event.clientX);
    if (drag.current !== null) {
      // Dragging past the first day turns the read into a range.
      const anchor = drag.current;
      setRange((r) => (r || at !== anchor ? { a: anchor, b: at } : null));
      setCursor(at);
    } else if (event.pointerType === "mouse" && !range) {
      // Mouse reads on hover; touch only while pressed.
      setCursor(at);
    }
  };

  const release = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.pointerType !== "mouse") {
      setCursor(null);
    }
  };

  const clearRead = () => {
    setRange(null);
    setCursor(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      clearRead();
      return;
    }
    const from = range ? range.b : (cursor ?? last + 1);
    const to = keyTarget(event.key, from, scanDays);
    if (to === undefined) {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) {
      setRange({ a: range ? range.a : (cursor ?? to), b: to });
    } else {
      setRange(null);
    }
    setCursor(to);
  };

  const choosePeriod = (days: number) => {
    clearRead();
    setPeriod(days);
  };

  const chooseSegment = (index: number) => {
    setFocus((f) => (f === index ? null : index));
  };

  const { span, ranged } = spanOf(range, cursor, last);
  const { day, twin, value, change, event, caption, comparison } = readOf(
    info,
    span,
    ranged,
    period,
    events
  );
  const parts = breakdown(info.current, span, segments.length);
  const formatted = format(value);
  const readText = comparison ? `${caption}, ${comparison}` : caption;
  const valueText = `${formatted}. ${readText}${event ? `, ${event.label}` : ""}`;

  const xOf = (i: number) => (last ? (i / last) * W : W);
  const pct = (i: number) => (xOf(i) / W) * 100;
  const topOf = (v: number) => `${(yOf(info.norm(v)) / H) * 100}%`;
  // The lit part of the line: up to the read day, across the range, or all.
  const litFrom = ranged && span ? xOf(span.lo) : 0;
  const litTo = span ? xOf(span.hi) : W;
  const firstDay = info.current[0];
  const lastDay = info.current.at(-1);
  const periodIndex = Math.max(0, periods.indexOf(period));
  const twinValue = span ? info.before[span.lo] : null;
  const dayValue = span ? info.now[span.lo] : null;

  return (
    <div
      className={cn(
        "w-full max-w-md select-none rounded-xl border border-border bg-card p-5 text-card-foreground",
        className
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <p className="truncate text-muted-foreground text-sm">
          {label}
          {focus !== null && (
            <span className="text-foreground"> · {segments[focus]}</span>
          )}
        </p>
        <div className="relative flex shrink-0 rounded-full bg-muted p-0.5 text-xs">
          {/* One pill slides between the periods. */}
          <span
            aria-hidden
            className="absolute top-0.5 bottom-0.5 left-0.5 w-10 rounded-full bg-background shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
            style={{ transform: `translateX(${periodIndex * 100}%)` }}
          />
          {periods.map((days) => (
            <button
              aria-label={`Last ${days} days, ${scans(scansIn[days] ?? 0)}`}
              aria-pressed={days === period}
              className={cn(
                "relative w-10 rounded-full py-1 font-medium tabular-nums outline-none transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                days === period
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              key={days}
              onClick={() => choosePeriod(days)}
              title={`${scans(scansIn[days] ?? 0)} in the last ${days} days`}
              type="button"
            >
              {days}D
            </button>
          ))}
        </div>
      </div>

      <p className="mt-3 font-semibold text-4xl tracking-tight">
        <span className="sr-only">{formatted}</span>
        <RollingNumber value={formatted} />
      </p>
      <div className="mt-1.5 flex min-h-5 items-center gap-2 text-sm tabular-nums">
        {change && (
          <span
            className={cn(
              "shrink-0 font-medium",
              { up: "text-success", down: "text-destructive", flat: "text-muted-foreground" }[change.tone]
            )}
          >
            {change.text}
          </span>
        )}
        <span aria-live="polite" className="truncate text-muted-foreground">
          {readText}
          {event && <span className="text-warning"> · {event.label}</span>}
        </span>
        {ranged && (
          <button
            className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-muted-foreground text-xs outline-none transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            onClick={clearRead}
            type="button"
          >
            Clear
          </button>
        )}
      </div>

      <div
        aria-label={`${label} over the last ${period} days. Arrow keys move between scans; hold Shift to select a range.`}
        aria-valuemax={info.current.length}
        aria-valuemin={1}
        aria-valuenow={span ? span.hi + 1 : info.current.length}
        aria-valuetext={valueText}
        className="relative mt-5 h-32 cursor-crosshair touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
        onBlur={() => setCursor(null)}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={release}
        onPointerCancel={release}
        onPointerDown={handlePointerDown}
        onPointerLeave={() => {
          if (drag.current === null && !range) {
            setCursor(null);
          }
        }}
        onPointerMove={handlePointerMove}
        ref={chartRef}
        role="slider"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full overflow-visible"
          preserveAspectRatio="none"
          viewBox={`0 0 ${W} ${H}`}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                height={H + 20}
                width={Math.max(0, litTo - litFrom)}
                x={litFrom}
                y={-10}
              />
            </clipPath>
          </defs>
          <line
            className="stroke-border"
            vectorEffect="non-scaling-stroke"
            x1={0}
            x2={W}
            y1={H - 0.5}
            y2={H - 0.5}
          />
          <path
            className="fill-none stroke-muted-foreground/40"
            d={info.paths.previous}
            strokeDasharray="3 4"
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
          />
          {/* The area only fills the part being read. */}
          <path
            className="fill-primary/10"
            clipPath={`url(#${clipId})`}
            d={info.paths.area}
          />
          <path
            className="fill-none stroke-primary/30"
            d={info.paths.current}
            strokeLinecap="round"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <path
            className="fill-none stroke-primary"
            clipPath={`url(#${clipId})`}
            d={info.paths.current}
            strokeLinecap="round"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* A dot on every scan day; a day alone between gaps is only a dot. */}
        {scanDays.map((i) => {
          const v = info.now[i];
          if (v === null) {
            return null;
          }
          const lit = !span || (i >= (ranged ? span.lo : 0) && i <= span.hi);
          return (
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                lit ? "bg-primary" : "bg-primary/30"
              )}
              data-scan-day={info.current[i].date}
              key={info.current[i].date}
              style={{ left: `${pct(i)}%`, top: topOf(v) }}
            />
          );
        })}

        {pinned.map((e) => (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-px -translate-x-1/2"
            key={e.date}
            style={{ left: `${pct(e.at)}%` }}
          >
            <div className="absolute inset-y-0 left-0 border-warning/30 border-l border-dashed" />
            <div className="absolute bottom-0 left-1/2 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-warning ring-2 ring-card" />
          </div>
        ))}

        {ranged &&
          span &&
          [span.lo, span.hi].map((i) => (
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-border"
              key={i}
              style={{ left: `${pct(i)}%` }}
            />
          ))}

        {day && span && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-border"
              style={{ left: `${pct(span.lo)}%` }}
            />
            {twin && twinValue !== null && twinValue !== undefined && (
              <div
                aria-hidden
                className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-muted-foreground/50 bg-card"
                style={{ left: `${pct(span.lo)}%`, top: topOf(twinValue) }}
              />
            )}
            {dayValue !== null && dayValue !== undefined && (
              <div
                aria-hidden
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-4 ring-card"
                style={{ left: `${pct(span.lo)}%`, top: topOf(dayValue) }}
              />
            )}
          </>
        )}
      </div>

      <div className="mt-2 flex justify-between text-muted-foreground text-xs tabular-nums">
        <span>{firstDay ? formatShort(firstDay.date) : ""}</span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-3 border-muted-foreground/40 border-t border-dashed" />
          Previous {period} days
        </span>
        <span>{lastDay ? formatShort(lastDay.date) : ""}</span>
      </div>

      {segments.length > 0 && (
        <Breakdown
          focus={focus}
          format={format}
          label={label}
          note={breakdownNote}
          onChoose={chooseSegment}
          parts={parts}
          segments={segments}
        />
      )}
    </div>
  );
}
