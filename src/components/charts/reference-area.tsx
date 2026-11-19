"use client";

// Perceev addition, not part of the vendored Bklit release. A horizontal band
// between two values on a y scale, e.g. the "not found" floor of a rank
// chart. The vendored shells already know the `ReferenceArea` name: they draw
// it under the series and outside the reveal clip, and collect its `y1` / `y2`
// (see chart-child-passthrough.ts and reference-area-config.ts).

import { useChartStable, useYScale } from "./chart-context";

export interface ReferenceAreaProps {
  /** One edge of the band, in data units. */
  y1: number;
  /** The other edge of the band, in data units. */
  y2: number;
  /** Scale group, as on `<Line yAxisId>`. Default: the primary axis. */
  yAxisId?: string | number;
  /** Band colour. Default: the chart foreground token. */
  fill?: string;
  /** Band opacity (0–1). Default: 0.06 */
  fillOpacity?: number;
}

export function ReferenceArea({
  y1,
  y2,
  yAxisId,
  fill = "var(--chart-foreground)",
  fillOpacity = 0.06,
}: ReferenceAreaProps) {
  const { innerWidth } = useChartStable();
  const scale = useYScale(yAxisId);
  const a = scale(y1);
  const b = scale(y2);
  if (!(Number.isFinite(a) && Number.isFinite(b))) {
    return null;
  }
  return (
    <rect
      aria-hidden="true"
      fill={fill}
      fillOpacity={fillOpacity}
      height={Math.abs(a - b)}
      width={innerWidth}
      x={0}
      y={Math.min(a, b)}
    />
  );
}

ReferenceArea.displayName = "ReferenceArea";

export default ReferenceArea;
