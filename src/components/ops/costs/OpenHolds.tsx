"use client";

/**
 * F03 §6.6.3 (5) — the reservations that are open right now, oldest first.
 *
 * A hold past its `expiresAt` is flagged "Expiring": the sync will settle it,
 * and until then it still counts against the workspace's position.
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
import { formatTimestamp, relativeTime } from "@/shared/format";
import { formatUsd } from "@/shared/money";
import type { OperatorCosts } from "@/shared/costs";

type HoldRow = OperatorCosts["openHolds"][number];

function isExpiring(expiresAt: string, now: number): boolean {
  const at = new Date(expiresAt).getTime();
  return Number.isFinite(at) && at < now;
}

export function OpenHolds({ rows }: { rows: HoldRow[] }) {
  const now = Date.now();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open holds</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            title="No open holds"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Feature</TableHead>
                <TableHead>Estimate</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.holdId}>
                  <TableCell className="font-medium">{row.brandKey}</TableCell>
                  <TableCell>{row.feature}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(row.estimateUsd)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {relativeTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span title={formatTimestamp(row.expiresAt)}>
                      {formatTimestamp(row.expiresAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {isExpiring(row.expiresAt, now) ? (
                      <Badge variant="warning">Expiring</Badge>
                    ) : (
                      <span className="text-muted-foreground">Held</span>
                    )}
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
