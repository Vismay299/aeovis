"use client";

/**
 * F03 §6.6.3 (2) — spend per workspace and feature for the chosen window.
 *
 * Operator-only numbers: a customer never reads this table. It is a report,
 * so it has no actions at all.
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

type WorkspaceRow = OperatorCosts["byWorkspace"][number];

export function CostsByWorkspace({ rows }: { rows: WorkspaceRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Spend by workspace</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            title="No spend in this range"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Feature</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Accounted</TableHead>
                <TableHead>Known</TableHead>
                <TableHead>Unknown</TableHead>
                <TableHead>Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.brandKey}:${row.feature}`}>
                  <TableCell className="font-medium">{row.brandKey}</TableCell>
                  <TableCell>{row.feature}</TableCell>
                  <TableCell className="tabular-nums">{row.calls}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(row.accountedUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(row.knownUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(row.unknownUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.openReconciliations}
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
