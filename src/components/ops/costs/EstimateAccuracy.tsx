"use client";

/**
 * F03 §6.6.3 (3) — how close the estimate was, per provider and endpoint.
 *
 * An undershoot is an actual cost above the estimate, so the row carries the
 * "Price may be stale" badge: that is the signal to reprice the endpoint, not
 * a reason to hide the row.
 */

import { EmptyState } from "@/components/app/EmptyState";
import { Badge } from "@/components/ui/badge";
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

type EndpointRow = OperatorCosts["byEndpoint"][number];

export function EstimateAccuracy({ rows }: { rows: EndpointRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Estimate accuracy</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            title="No measured calls in this range"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Estimated</TableHead>
                <TableHead>Actual</TableHead>
                <TableHead>Unknown</TableHead>
                <TableHead>Undershoots</TableHead>
                <TableHead>Worst ratio</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.provider}:${row.endpoint}`}>
                  <TableCell className="font-medium">{row.provider}</TableCell>
                  <TableCell>{row.endpoint}</TableCell>
                  <TableCell className="tabular-nums">{row.calls}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(row.estimateUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(row.actualUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.unknownCalls}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <span className="flex flex-wrap items-center gap-2">
                      {row.undershoots}
                      {row.undershoots > 0 ? (
                        <Badge variant="warning">Price may be stale</Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.maxRatio === null ? "—" : row.maxRatio.toFixed(2)}
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
