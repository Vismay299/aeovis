"use client";

import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RankGridPoint } from "./RankGridSvg";

export type GridPointTableProps = {
  points: RankGridPoint[] | null;
};

/** The per-point table: the same numbers as the SVG, in a form that scrolls on a phone. */
export function GridPointTable({ points }: GridPointTableProps) {
  return (
    <div data-slot="grid-point-table">
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Col</TableHead>
              <TableHead>Lat</TableHead>
              <TableHead>Lng</TableHead>
              <TableHead>Rank</TableHead>
              <TableHead>Results</TableHead>
              <TableHead>#1 business</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(points ?? []).map((point) => (
              <TableRow key={`${point.row}-${point.col}`}>
                <TableCell>{point.row + 1}</TableCell>
                <TableCell>{point.col + 1}</TableCell>
                <TableCell className="tabular-nums">
                  {point.latitude.toFixed(5)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {point.longitude.toFixed(5)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {point.error ? "×" : (point.rank ?? "–")}
                </TableCell>
                <TableCell className="tabular-nums">
                  {point.error ? "—" : (point.resultsCount ?? "—")}
                </TableCell>
                <TableCell className="max-w-[16rem] truncate">
                  {point.topResult?.title ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>
    </div>
  );
}
