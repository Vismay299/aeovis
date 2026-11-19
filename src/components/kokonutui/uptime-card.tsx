"use client";

/**
 * @author: @dorianbaffier
 * @description: Uptime Card
 * @version: 1.0.0
 * @date: 2026-10-15
 * @license: MIT
 * @website: https://kokonutui.com
 * @github: https://github.com/kokonut-labs/kokonutui
 */

// Perceev edit (T9): reshaped for scan days instead of uptime.
// - Each row carries one status per day, taken from stored data; nothing is
//   assumed "up". Statuses are answered, failed, not assessed, or no scan.
// - Uptime percentages, incident minutes and the incident log are gone: the
//   data has none of them. A row says "Measured on N of D days", and a pinned
//   day lists each row's status.
// - Built-in sample services and dates are gone; `services` and `endDate` are
//   required. The UI lab passes its own sample.
// - The axis names the first and last dates rather than "Today", which the
//   last day may not be.
// - Colours use the app's tokens instead of zinc / white.

import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/shared/utils";

// How much wider the bar under the pointer gets, and how far the swell
// spreads, in bars.
const MAGNIFY = 5;
const SPREAD = 2.4;
// Bars ease toward their width at this rate, per second.
const EASE = 18;
const DAY = 86_400_000;

/**
 * up: measured that day. down: the measurement failed. unassessed: a scan ran
 * but this row could not be assessed. none: no scan that day.
 */
export type DayStatus = "up" | "down" | "unassessed" | "none";

export interface UptimeService {
  name: string;
  /** One status per day, oldest first; the last is `endDate`. */
  days: DayStatus[];
}

export interface UptimeCardProps {
  title: string;
  services: UptimeService[];
  /** The last day shown, as YYYY-MM-DD. */
  endDate: string;
  className?: string;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const formatDay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const formatShort = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const statusOf = (service: UptimeService, day: number): DayStatus =>
  service.days[day] ?? "none";

/** Target widths: a swell around the focus, flat without one. */
function swell(count: number, focus: number | null, out: Float64Array) {
  for (let i = 0; i < count; i++) {
    out[i] =
      focus === null
        ? 1
        : 1 + MAGNIFY * Math.exp(-(((i - focus) / SPREAD) ** 2));
  }
  return out;
}

/** The bar under x (0 to 1) when bars have these widths. */
function barAt(weights: Float64Array, x: number) {
  let total = 0;
  for (const w of weights) {
    total += w;
  }
  let at = x * total;
  for (let i = 0; i < weights.length; i++) {
    at -= weights[i];
    if (at <= 0) {
      return i;
    }
  }
  return weights.length - 1;
}

const BAR_COLOR: Record<DayStatus, string> = {
  up: "bg-success",
  down: "bg-destructive",
  unassessed: "bg-muted-foreground/35",
  none: "bg-muted",
};

const PILL_COLOR: Record<DayStatus, string> = {
  up: "bg-success/15 text-success",
  down: "bg-destructive/15 text-destructive",
  unassessed: "bg-muted text-muted-foreground",
  none: "bg-muted text-muted-foreground",
};

const STATUS_TEXT: Record<DayStatus, string> = {
  up: "Answered",
  down: "Failed",
  unassessed: "Not assessed",
  none: "No scan",
};

const ORDER: DayStatus[] = ["up", "down", "unassessed"];

/** "2 answered, 1 failed", or "No scan" when no row has anything that day. */
function describeDay(services: UptimeService[], day: number) {
  const counts = new Map<DayStatus, number>();
  for (const service of services) {
    const status = statusOf(service, day);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts = ORDER.filter((s) => counts.get(s)).map(
    (s) => `${counts.get(s)} ${STATUS_TEXT[s].toLowerCase()}`
  );
  return parts.length ? parts.join(", ") : STATUS_TEXT.none;
}

export default function UptimeCard({
  title,
  services,
  endDate,
  className,
}: UptimeCardProps) {
  const days = Math.max(1, ...services.map((s) => s.days.length));
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const sim = useRef({
    weights: new Float64Array(days).fill(1),
    target: new Float64Array(days).fill(1),
    focus: null as number | null,
    raf: 0,
    last: 0,
    reduceMotion: false,
  });
  if (sim.current.weights.length !== days) {
    sim.current.weights = new Float64Array(days).fill(1);
    sim.current.target = new Float64Array(days).fill(1);
  }

  const end = Date.parse(`${endDate}T00:00:00Z`);
  const dateOf = useCallback(
    (day: number) => end - (days - 1 - day) * DAY,
    [end, days]
  );
  const counts = useMemo(
    () =>
      services.map((s) => ({
        measured: s.days.filter((d) => d === "up").length,
        failed: s.days.filter((d) => d === "down").length,
      })),
    [services]
  );
  // The newest day any row has something for.
  const lastScan = useMemo(() => {
    for (let day = days - 1; day >= 0; day--) {
      if (services.some((s) => statusOf(s, day) !== "none")) {
        return day;
      }
    }
    return null;
  }, [services, days]);
  const failedLast =
    lastScan === null
      ? 0
      : services.filter((s) => statusOf(s, lastScan) === "down").length;

  // Widths are written straight to the bars, one flex-grow per bar.
  const paint = useCallback(() => {
    const rows = barsRef.current?.querySelectorAll<HTMLElement>("[data-row]");
    const { weights } = sim.current;
    for (const row of rows ?? []) {
      const bars = row.children;
      for (let i = 0; i < bars.length; i++) {
        (bars[i] as HTMLElement).style.flexGrow = weights[i].toFixed(3);
      }
    }
  }, []);

  const tick = useCallback(
    (now: number) => {
      const s = sim.current;
      s.raf = 0;
      const dt = s.last ? Math.min((now - s.last) / 1000, 1 / 30) : 1 / 60;
      s.last = now;
      const k = 1 - Math.exp(-EASE * dt);
      let moving = false;
      for (let i = 0; i < s.weights.length; i++) {
        const gap = s.target[i] - s.weights[i];
        if (Math.abs(gap) > 0.002) {
          s.weights[i] += gap * k;
          moving = true;
        } else {
          s.weights[i] = s.target[i];
        }
      }
      paint();
      if (moving) {
        s.raf = requestAnimationFrame(tick);
      } else {
        s.last = 0;
      }
    },
    [paint]
  );

  const focusOn = useCallback(
    (focus: number | null) => {
      const s = sim.current;
      s.focus = focus;
      swell(s.weights.length, focus, s.target);
      if (s.reduceMotion) {
        s.weights.set(s.target);
        paint();
      } else if (!s.raf) {
        s.raf = requestAnimationFrame(tick);
      }
    },
    [paint, tick]
  );

  useEffect(() => {
    const s = sim.current;
    s.reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    return () => cancelAnimationFrame(s.raf);
  }, []);

  /** The day under the pointer, found against the swollen layout. */
  const dayAt = (clientX: number) => {
    const rect = barsRef.current?.getBoundingClientRect();
    if (!rect) {
      return 0;
    }
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const probe = new Float64Array(days);
    let day = Math.round(x * (days - 1));
    // Centre the swell on the bar that ends up under the pointer.
    for (let pass = 0; pass < 3; pass++) {
      day = barAt(swell(days, day, probe), x);
    }
    return day;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "mouse" &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }
    const day = dayAt(event.clientX);
    // Most moves stay on the same bar: skip the re-render and the retarget.
    if (day === active) {
      return;
    }
    setActive(day);
    focusOn(day);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (event.pointerType !== "mouse") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const day = dayAt(event.clientX);
    setActive(day);
    focusOn(day);
  };

  const handleClick = () => {
    if (active !== null) {
      setPinned((p) => (p === active ? null : active));
    }
  };

  const leave = () => {
    setActive(null);
    focusOn(pinned);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? pinned ?? days - 1;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      Home: -days,
      End: days,
    };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setPinned((p) => (p === from ? null : from));
      return;
    }
    if (event.key === "Escape") {
      setPinned(null);
      setActive(null);
      focusOn(null);
      return;
    }
    const move = moves[event.key];
    if (move === undefined) {
      return;
    }
    event.preventDefault();
    const day = clamp(from + move, 0, days - 1);
    setActive(day);
    focusOn(day);
  };

  const shownDay = active ?? pinned;
  const summary =
    shownDay === null
      ? "Hover a day to see each engine"
      : `${formatDay(dateOf(shownDay))} · ${describeDay(services, shownDay)}`;
  // The log keeps showing the last pinned day while it collapses.
  const lastPinned = useRef<number | null>(null);
  if (pinned !== null) {
    lastPinned.current = pinned;
  }
  const logDay = pinned ?? lastPinned.current;

  let headline = (
    <p className="text-muted-foreground text-sm">No scans in this range</p>
  );
  if (lastScan !== null) {
    const when = formatShort(dateOf(lastScan));
    headline = failedLast ? (
      <p className="text-sm text-warning">
        {failedLast} of {services.length} failed on {when}
      </p>
    ) : (
      <p className="text-muted-foreground text-sm">
        Last scan {when} · {describeDay(services, lastScan)}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "w-full max-w-xl select-none rounded-xl border border-border bg-card p-5 text-card-foreground",
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="font-medium text-sm">{title}</p>
        {headline}
      </div>
      <p
        aria-live="polite"
        className="mt-1 truncate text-muted-foreground text-sm tabular-nums"
      >
        {summary}
      </p>

      <div
        aria-label={`Daily status for the last ${days} days. Use the arrow keys to move between days and Enter to open one.`}
        aria-valuemax={days}
        aria-valuemin={1}
        aria-valuenow={(shownDay ?? days - 1) + 1}
        aria-valuetext={summary}
        className="mt-4 cursor-pointer touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
        onBlur={() => {
          if (active !== null) {
            leave();
          }
        }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={(event) => {
          // A touch's implicit capture on the bar it started on moves to this
          // element on pointerdown; that bubbling event is not the end.
          if (event.target === event.currentTarget) {
            leave();
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") {
            leave();
          }
        }}
        onPointerMove={handlePointerMove}
        ref={barsRef}
        role="slider"
        tabIndex={0}
      >
        {services.map((service, row) => (
          <div className={cn(row > 0 && "mt-3")} key={service.name}>
            <div className="mb-1.5 flex justify-between gap-3 text-xs">
              <span className="truncate font-medium">{service.name}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                Measured on {counts[row].measured} of {days} days
                {counts[row].failed ? (
                  <span className="text-destructive">
                    {" "}
                    · failed on {counts[row].failed}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex h-7 gap-px sm:gap-[2px]" data-row>
              {Array.from({ length: days }, (_, day) => {
                const status = statusOf(service, day);
                const lit = day === shownDay;
                return (
                  <div
                    className={cn(
                      "min-w-0 basis-0 rounded-[2px] transition-opacity duration-150 ease-out motion-reduce:transition-none",
                      BAR_COLOR[status],
                      shownDay !== null && !lit && "opacity-60"
                    )}
                    data-status={status}
                    // biome-ignore lint/suspicious/noArrayIndexKey: one bar per day, never reordered
                    key={day}
                    style={{ flexGrow: 1 }}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="mt-2 flex justify-between text-muted-foreground text-xs tabular-nums">
          <span>{formatShort(dateOf(0))}</span>
          <span>{formatShort(dateOf(days - 1))}</span>
        </div>
      </div>

      {/* A pinned day lists every row's status. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-[260ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
          pinned === null
            ? "grid-rows-[0fr] opacity-0"
            : "grid-rows-[1fr] opacity-100"
        )}
        inert={pinned === null}
      >
        <div className="overflow-hidden">
          {logDay !== null && (
            <div className="mt-4 rounded-lg bg-muted/50 p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium text-sm">
                  {formatDay(dateOf(logDay))}
                </p>
                <button
                  aria-label="Close day"
                  className="rounded-full p-1 text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                  onClick={() => {
                    setPinned(null);
                    focusOn(null);
                  }}
                  type="button"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
              <ul className="mt-2 grid gap-1.5">
                {services.map((service) => {
                  const status = statusOf(service, logDay);
                  return (
                    <li
                      className="flex items-center justify-between gap-3 text-sm"
                      key={service.name}
                    >
                      <span className="truncate">{service.name}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 font-medium text-[11px]",
                          PILL_COLOR[status]
                        )}
                      >
                        {STATUS_TEXT[status]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
