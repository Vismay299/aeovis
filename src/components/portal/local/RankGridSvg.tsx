"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { googleMapsPointUrl } from "@/shared/local-coordinates";
import { cn } from "@/shared/utils";

export type RankGridPoint = {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
  rank: number | null;
  resultsCount?: number;
  topResult?: { title: string | null; cid: string | null } | null;
  error?: true;
};

export type RankGridSvgProps = {
  /** Null while the grid is still processing: every cell is a placeholder. */
  points: RankGridPoint[] | null;
  gridSize: number;
  spacingKm: number;
  center: { latitude: number; longitude: number };
  zoom: number;
  keyword?: string;
  pointsReady?: number;
  pointsTotal?: number;
};

const CELL = 100;
const RADIUS = 34;

function formatPoint(value: number): string {
  return value.toFixed(5);
}

type CellState = "pending" | "ranked" | "empty" | "failed";

function cellState(point: RankGridPoint | undefined): CellState {
  if (!point) return "pending";
  if (point.error) return "failed";
  if (point.rank == null) return "empty";
  return "ranked";
}

export function rankBucket(rank: number | null | undefined): "good" | "mid" | "low" | null {
  if (rank == null) return null;
  if (rank <= 3) return "good";
  if (rank <= 10) return "mid";
  return "low";
}

/**
 * An inline schematic of the rank grid. The points are equidistant in
 * kilometres by construction, so a square SVG is a true-to-scale picture of
 * the search area; map tiles would send the customer's storefront to a third
 * party on every view and add nothing the numbers do not say.
 */
export function RankGridSvg({
  points,
  gridSize,
  spacingKm,
  center,
  zoom,
  keyword,
  pointsReady = 0,
  pointsTotal = gridSize * gridSize,
}: RankGridSvgProps) {
  const n = Math.max(3, gridSize);
  const total = Math.max(n * n, pointsTotal);
  const cellRefs = useRef<Array<SVGGElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [points, gridSize]);

  const moveTo = (next: number) => {
    const clamped = Math.max(0, Math.min(total - 1, next));
    setActiveIndex(clamped);
    cellRefs.current[clamped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const row = Math.floor(activeIndex / n);
    const col = activeIndex % n;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveTo(activeIndex + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveTo(activeIndex - 1);
        break;
      case "ArrowDown":
        if (row < n - 1) {
          event.preventDefault();
          moveTo(activeIndex + n);
        }
        break;
      case "ArrowUp":
        if (row > 0) {
          event.preventDefault();
          moveTo(activeIndex - n);
        }
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(total - 1);
        break;
      default:
        break;
    }
  };

  const middle = (n - 1) / 2;
  const activePoint = points?.[activeIndex];
  const activeState = cellState(activePoint);
  const activeRow = Math.floor(activeIndex / n);
  const activeCol = activeIndex % n;

  return (
    <div className="space-y-3" data-slot="rank-grid-svg">
      {points === null ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {`${pointsReady} of ${pointsTotal} searches back`}
        </p>
      ) : null}

      <svg
        viewBox={`0 0 ${CELL * n} ${CELL * n}`}
        role="grid"
        aria-label={`Map ranking grid, ${n} by ${n} points ${spacingKm} km apart`}
        className="block w-full"
        style={{ maxWidth: 520 }}
        onKeyDown={onKeyDown}
      >
        <defs>
          <pattern
            id="rank-grid-failed"
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="8" height="8" fill="var(--line-strong)" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="8"
              stroke="var(--ink-4)"
              strokeWidth="2"
            />
          </pattern>
        </defs>

        {Array.from({ length: total }, (_, index) => {
          const row = Math.floor(index / n);
          const col = index % n;
          const point = points?.[index];
          const state = cellState(point);
          const bucket = state === "ranked" ? rankBucket(point?.rank) : null;
          const isCenter = row === middle && col === middle;
          const cx = CELL / 2 + CELL * col;
          const cy = CELL / 2 + CELL * row;

          const fill =
            state === "failed"
              ? "url(#rank-grid-failed)"
              : state === "pending"
                ? "var(--line-soft)"
                : bucket === "good"
                  ? "var(--good)"
                  : bucket === "mid"
                    ? "var(--warn)"
                    : bucket === "low"
                      ? "var(--crit)"
                      : "var(--line-strong)";
          const ink =
            bucket === null ? "var(--ink-3)" : "var(--on-good, #fff)";
          const label =
            state === "pending"
              ? ""
              : state === "failed"
                ? "×"
                : state === "empty"
                  ? "–"
                  : String(point?.rank ?? "");

          return (
            <g
              key={`${row}-${col}`}
              ref={(node) => {
                cellRefs.current[index] = node;
              }}
              role="gridcell"
              aria-label={
                state === "ranked"
                  ? `Row ${row + 1}, column ${col + 1}: rank ${point?.rank}`
                  : state === "empty"
                    ? `Row ${row + 1}, column ${col + 1}: not in the results`
                    : state === "failed"
                      ? `Row ${row + 1}, column ${col + 1}: search failed`
                      : `Row ${row + 1}, column ${col + 1}: waiting`
              }
              tabIndex={index === activeIndex ? 0 : -1}
              data-point={`${row}-${col}`}
              data-state={state}
              data-rank={point?.rank ?? undefined}
              className="cursor-pointer outline-none focus-visible:[&>circle]:stroke-[5px]"
              onFocus={() => setActiveIndex(index)}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => setActiveIndex(index)}
            >
              <circle
                cx={cx}
                cy={cy}
                r={RADIUS}
                fill={fill}
                stroke={isCenter ? "var(--brand)" : "transparent"}
                strokeWidth={isCenter ? 3 : 0}
              />
              {isCenter ? (
                // A small pin glyph marks the storefront at the centre point.
                <path
                  d={`M ${cx} ${cy - RADIUS + 8} l 6 9 a 7 7 0 1 1 -12 0 z`}
                  fill="var(--brand)"
                  transform={`translate(-0, 0)`}
                  opacity="0.9"
                />
              ) : null}
              <text
                x={cx}
                y={cy + (state === "ranked" ? 6 : 7)}
                textAnchor="middle"
                fill={ink}
                fontSize="26"
                fontWeight="600"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {label}
              </text>
            </g>
          );
        })}

        <text
          x={CELL * n - 14}
          y={26}
          textAnchor="end"
          fill="var(--ink-3)"
          fontSize="20"
          fontWeight="700"
          aria-hidden="true"
        >
          N
        </text>
      </svg>

      <div className="flex items-center gap-2 text-xs text-muted-foreground" style={{ maxWidth: 520 }}>
        <span
          className="inline-block h-px bg-foreground"
          // One cell of the drawn grid: the SVG scales to this container (max 520 px).
          style={{ width: `${100 / n}%` }}
          aria-hidden="true"
        />
        <span>{`${spacingKm} km`}</span>
      </div>

      <div
        className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1"
        data-slot="grid-point-tooltip"
        aria-live="polite"
      >
        <div>
          {`Row ${activeRow + 1}, column ${activeCol + 1} · ${formatPoint(
            activePoint?.latitude ?? center.latitude
          )}, ${formatPoint(activePoint?.longitude ?? center.longitude)}`}
        </div>
        <div>
          {activeState === "ranked"
            ? `Rank ${activePoint?.rank}`
            : activeState === "empty"
              ? `Not in the ${activePoint?.resultsCount ?? 0} results here`
              : activeState === "failed"
                ? "Search failed"
                : "Waiting for this search"}
        </div>
        {activeState === "empty" &&
        (activePoint?.resultsCount ?? 0) < 5 ? (
          <div>Few businesses here</div>
        ) : null}
        {activePoint?.topResult?.title ? (
          <div>{`#1 here: ${activePoint.topResult.title}`}</div>
        ) : null}
        {activePoint ? (
          <a
            className="inline-flex items-center gap-1 underline underline-offset-2"
            href={googleMapsPointUrl(
              activePoint.latitude,
              activePoint.longitude,
              zoom,
              keyword
            )}
            target="_blank"
            rel="noreferrer"
          >
            Open in Google Maps
          </a>
        ) : null}
      </div>

      <table className={cn("sr-only")}>
        <caption>Rank grid points</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Column</th>
            <th scope="col">Rank</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: total }, (_, index) => {
            const row = Math.floor(index / n);
            const col = index % n;
            const point = points?.[index];
            const state = cellState(point);
            return (
              <tr key={`sr-${row}-${col}`}>
                <td>{row + 1}</td>
                <td>{col + 1}</td>
                <td>
                  {state === "ranked"
                    ? String(point?.rank)
                    : state === "empty"
                      ? "Not in results"
                      : state === "failed"
                        ? "Search failed"
                        : "Waiting"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
