"use client";

// Perceev addition, not part of the vendored Bklit release. Bklit ships an
// x axis for time series (`XAxis`) and a category axis for bars
// (`BarYAxis`), but no numeric value axis. This one reads the y scale the
// chart already publishes in its context and labels its ticks, so it follows
// whatever domain the chart settled on: the zero-anchored default, a second
// axis (`yAxisId`), or a reversed domain set through `LineChart`'s
// `yDomainOverrides` (rank charts, where 1 sits at the top).

import { memo, useMemo } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/shared/utils";
import {
  useChartPortalContainer,
  useChartStable,
  useYScale,
} from "./chart-context";
import { resolveYAxisTickCount } from "./y-axis-ticks";

export interface YAxisProps {
  /** Scale group to label, as on `<Line yAxisId>`. Default: the primary axis. */
  yAxisId?: string | number;
  /** Side of the plot. Labels sit inside that margin. Default: "left" */
  position?: "left" | "right";
  /**
   * Tick count hint for `scale.ticks()`. Default: 5, the same as `Grid`'s
   * `numTicksRows`, so labels line up with the grid rows.
   */
  numTicks?: number;
  /** Explicit tick values. Values outside the current domain are dropped. */
  tickValues?: number[];
  /** Keep non-integer ticks. Default: true */
  allowDecimals?: boolean;
  /** Label text for a tick value. Default: `String(value)` */
  formatValue?: (value: number) => string;
  /** Classes merged over each label (base: `text-chart-label text-xs`). */
  labelClassName?: string;
}

const defaultFormat = (value: number) => String(value);

/** Tick values for a scale, honouring `tickValues` / `allowDecimals`. */
export function resolveYAxisTicks(
  scale: { domain(): number[]; ticks(count?: number): number[] },
  {
    numTicks,
    tickValues,
    allowDecimals = true,
  }: Pick<YAxisProps, "numTicks" | "tickValues" | "allowDecimals">
): number[] {
  const domain = scale.domain();
  const lo = Math.min(domain[0] ?? 0, domain[1] ?? 0);
  const hi = Math.max(domain[0] ?? 0, domain[1] ?? 0);
  const values = tickValues
    ? tickValues.filter((value) => value >= lo && value <= hi)
    : scale.ticks(resolveYAxisTickCount(numTicks));
  return allowDecimals
    ? values
    : values.filter((value) => Number.isInteger(value));
}

export function YAxis(props: YAxisProps) {
  const { containerRef } = useChartStable();
  const container = useChartPortalContainer(containerRef);
  if (!container) {
    return null;
  }
  return <YAxisInner {...props} container={container} />;
}

const YAxisInner = memo(function YAxisInner({
  yAxisId,
  position = "left",
  numTicks,
  tickValues,
  allowDecimals = true,
  formatValue = defaultFormat,
  labelClassName,
  container,
}: YAxisProps & { container: HTMLDivElement }) {
  const { margin } = useChartStable();
  const scale = useYScale(yAxisId);

  const ticks = useMemo(
    () =>
      resolveYAxisTicks(scale, { numTicks, tickValues, allowDecimals }).map(
        (value) => ({
          value,
          top: margin.top + (scale(value) ?? 0),
          label: formatValue(value),
        })
      ),
    [scale, numTicks, tickValues, allowDecimals, formatValue, margin.top]
  );

  const isLeft = position === "left";
  const gutter = isLeft ? margin.left : margin.right;

  return createPortal(
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {ticks.map((tick) => (
        <div
          className="absolute"
          key={tick.value}
          style={{
            top: tick.top,
            width: gutter,
            transform: "translateY(-50%)",
            ...(isLeft
              ? { left: 0, paddingRight: 8, textAlign: "right" }
              : { right: 0, paddingLeft: 8, textAlign: "left" }),
          }}
        >
          <span
            className={cn(
              "whitespace-nowrap text-chart-label text-xs tabular-nums",
              labelClassName
            )}
          >
            {tick.label}
          </span>
        </div>
      ))}
    </div>,
    container
  );
});

YAxis.displayName = "YAxis";

export default YAxis;
