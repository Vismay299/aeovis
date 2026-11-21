"use client";

import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { AreaSparkline } from "@/components/charts";
import { RollingNumber } from "@/components/app/motion/RollingNumber";
import { cn } from "@/shared/utils";

export type StatTileVariant = "plain" | "spark" | "rail" | "ring" | "inverse";

export interface StatTileProps {
  label: string;
  /** Already formatted: "1,204", "38". A null value renders an em dash. */
  value: string | null;
  suffix?: string;
  sub?: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Change since the last period, already formatted: "+8 pts". */
  delta?: { text: string; direction: "up" | "down" | "flat" };
  /** Recent values, oldest first, for the spark line. */
  series?: readonly number[];
  /** 0–100, for the ring. */
  percent?: number;
  variant?: StatTileVariant;
  className?: string;
}

function Delta({ delta, inverse = false }: { delta: NonNullable<StatTileProps["delta"]>; inverse?: boolean }) {
  const Icon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;
  const tone =
    delta.direction === "up" ? "var(--success)" : delta.direction === "down" ? "var(--destructive)" : "var(--muted-foreground)";
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
      style={
        inverse
          ? { color: "var(--background)", background: "color-mix(in oklab, var(--background) 12%, transparent)" }
          : { color: tone, background: `color-mix(in oklab, ${tone} 15%, transparent)` }
      }
    >
      <Icon className="size-3" aria-hidden />
      {delta.text}
    </span>
  );
}

/** The Bklit area sparkline: draws in, and reads out a value under the pointer. */
function Spark({ series }: { series: readonly number[] }) {
  const data = React.useMemo(() => series.map((value, index) => ({ index, value })), [series]);
  return (
    <div data-slot="stat-spark">
      <AreaSparkline data={data} dataKey="value" height={44} color="var(--primary)" strokeWidth={2} endDot />
    </div>
  );
}

/** A ring that fills to `percent`. */
function Ring({ percent, children }: { percent: number; children?: React.ReactNode }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <span className="relative grid size-16 shrink-0 place-items-center">
      <svg data-slot="stat-ring" viewBox="0 0 40 40" aria-hidden className="absolute inset-0 size-full -rotate-90">
        <circle cx="20" cy="20" r="16.5" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="3.5" />
        <circle
          cx="20"
          cy="20"
          r="16.5"
          pathLength={100}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={100 - clamped}
          style={{
            animation: "ring-fill 1100ms var(--ease-out-quart) 100ms backwards",
            transition: "stroke-dashoffset 900ms var(--ease-out-quart)",
          }}
        />
      </svg>
      <span className="relative text-[13px] font-semibold tabular-nums">{children}</span>
    </span>
  );
}

/**
 * A headline number. `variant` picks one of the tile designs under review;
 * the number always rolls and the tile always carries the same content.
 */
export function StatTile({
  label,
  value,
  suffix,
  sub,
  icon: Icon,
  delta,
  series,
  percent,
  variant = "plain",
  className,
}: StatTileProps) {
  const blank = value === null || value === "";
  const number = (size: string) => (
    <span className={cn("font-semibold tracking-tight tabular-nums", size)}>
      {blank ? "—" : <RollingNumber>{value}</RollingNumber>}
      {!blank && suffix ? <small className="ml-0.5 text-[0.5em] font-medium opacity-60">{suffix}</small> : null}
    </span>
  );

  if (variant === "spark") {
    return (
      <div data-slot="stat-tile" data-variant={variant} className={cn("flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-4", className)}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
            {Icon ? (
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground/8 text-foreground">
                <Icon className="size-3.5" />
              </span>
            ) : null}
            <span className="truncate">{label}</span>
          </span>
          {delta ? <Delta delta={delta} /> : null}
        </div>
        {number("text-3xl")}
        {sub ? <span className="truncate text-xs text-muted-foreground">{sub}</span> : null}
        {series && series.length > 1 ? <div className="-mx-1 -mb-1 mt-auto"><Spark series={series} /></div> : null}
      </div>
    );
  }

  if (variant === "rail") {
    return (
      <div data-slot="stat-tile" data-variant={variant} className={cn("group/stat relative flex flex-col gap-1.5 overflow-hidden rounded-xl border border-border bg-card py-4 pl-5 pr-4", className)}>
        <span
          aria-hidden
          className="absolute inset-y-3 left-0 w-[3px] origin-top rounded-r-full bg-primary transition-[inset] duration-300 ease-(--ease-spring) group-hover/stat:inset-y-1"
          style={{ animation: "scroll-grow-y 700ms var(--ease-out-quart) both" }}
        />
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
          {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        </span>
        {number("text-4xl leading-none")}
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {delta ? <Delta delta={delta} /> : null}
          {sub ? <span className="truncate">{sub}</span> : null}
        </span>
      </div>
    );
  }

  if (variant === "ring") {
    return (
      <div data-slot="stat-tile" data-variant={variant} className={cn("flex items-center gap-4 rounded-xl border border-border bg-card p-4", className)}>
        <Ring percent={percent ?? 0}>{Math.round(percent ?? 0)}%</Ring>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
          {number("text-2xl")}
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {delta ? <Delta delta={delta} /> : null}
            {sub ? <span className="truncate">{sub}</span> : null}
          </span>
        </div>
      </div>
    );
  }

  if (variant === "inverse") {
    return (
      <div
        data-slot="stat-tile"
        data-variant={variant}
        className={cn("relative flex flex-col gap-2 overflow-hidden rounded-xl bg-foreground p-4 text-background", className)}
        style={{
          backgroundImage: "radial-gradient(color-mix(in oklab, var(--background) 16%, transparent) 1px, transparent 1px)",
          backgroundSize: "14px 14px",
          backgroundPosition: "-1px -1px",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{label}</span>
          </span>
          {delta ? <Delta delta={delta} inverse /> : null}
        </div>
        {number("text-4xl leading-none")}
        {sub ? <span className="truncate text-xs opacity-70">{sub}</span> : null}
      </div>
    );
  }

  return (
    <div data-slot="stat-tile" data-variant="plain" className={cn("flex flex-col gap-1 rounded-xl border border-border bg-card p-4", className)}>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? <Icon className="size-4" /> : null}
        {label}
      </span>
      {number("text-2xl")}
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

export default StatTile;
