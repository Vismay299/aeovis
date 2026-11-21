import { cn } from "@/shared/utils";

export interface ChartLegendItem {
  label: string;
  color: string;
}

/**
 * Series key under a Bklit chart: a square swatch and the series label for
 * each item, centred, in the chart label size. Colours are the same token
 * strings the series use (`var(--chart-1)`, …).
 */
export function ChartLegend({
  items,
  className,
}: {
  items: readonly ChartLegendItem[];
  className?: string;
}) {
  return (
    <ul
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
