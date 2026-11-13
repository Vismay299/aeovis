"use client";

/**
 * F03 §6.6.3 (4) — the typical cost of one answer per engine.
 *
 * `engine_cost_stats` only emits a row at 20 measured samples, so a missing row
 * is not "free": the section says what is missing instead of inventing a
 * median.
 */

import { EmptyState } from "@/components/app/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/shared/money";
import type { OperatorCosts } from "@/shared/costs";

type EngineRow = OperatorCosts["engineStats"][number];

const NOT_ENOUGH = "Not enough samples (needs 20)";

export function EngineStats({ rows }: { rows: EngineRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Typical answer cost</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            title={NOT_ENOUGH}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Engine</TableHead>
                <TableHead>Samples</TableHead>
                <TableHead>Median</TableHead>
                <TableHead>p90</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.engine}>
                  <TableCell className="font-medium">{row.engine}</TableCell>
                  <TableCell className="tabular-nums">{row.samples}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.medianUsd === null ? NOT_ENOUGH : formatUsd(row.medianUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.p90Usd === null ? NOT_ENOUGH : formatUsd(row.p90Usd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
