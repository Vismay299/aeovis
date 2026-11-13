"use client";

/**
 * F03 §6.6.2 — what one scan cost.
 *
 * The card is honest about what it does not know: a cost that has not been
 * reported is drawn as "Unknown" or as an em dash with its reason, never as
 * $0. It polls nothing — the report page loads once, and a retry re-renders it.
 */

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { engineLabel } from "@/components/portal/scans/reportData";
import { formatUsd } from "@/shared/money";
import type { ScanCost } from "@/shared/costs";

/** How many per-answer rows one "Show more" adds. */
const PER_ANSWER_PAGE = 25;

/** `results[i].cost` as the report route adds it. */
export type ScanResultCost = {
  usd: number | null;
  attempts: number;
  unknownAttempts: number;
} | null;

/** The part of a `results[i]` row this card reads. */
type ScanResultRow = {
  query?: unknown;
  engine?: unknown;
  cost?: ScanResultCost;
};

function attemptsWord(count: number): string {
  return count === 1 ? "attempt" : "attempts";
}

function resultText(row: ScanResultRow | null | undefined, field: "query"): string {
  const value = row?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : "Untitled question";
}

/** "Question · Engine · Attempts · Cost", 25 rows at a time. */
function CostPerAnswer({ results }: { results: ScanResultRow[] }) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(PER_ANSWER_PAGE);

  const rows = results.map((row, index) => ({
    key: `${index}`,
    question: resultText(row, "query"),
    engine: engineLabel(row?.engine),
    attempts: row?.cost?.attempts ?? 0,
    usd: row?.cost ? row.cost.usd : null,
  }));

  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide cost per answer" : "Show cost per answer"}
      </Button>

      {open ? (
        rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No answers were recorded for this scan.
          </p>
        ) : (
          <div className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Question</TableHead>
                  <TableHead>Engine</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, visible).map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="max-w-64 truncate">{row.question}</TableCell>
                    <TableCell>{row.engine}</TableCell>
                    <TableCell className="tabular-nums">{row.attempts}</TableCell>
                    <TableCell className="tabular-nums">
                      {row.usd === null ? "Unknown" : formatUsd(row.usd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {visible < rows.length ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVisible((count) => count + PER_ANSWER_PAGE)}
              >
                Show more
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function NotAvailable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Cost details are not available for this scan.
        </p>
      </CardContent>
    </Card>
  );
}

export function ScanCostCard({
  cost,
  results = [],
}: {
  /** `scan.cost`; an older API answers without it. */
  cost?: ScanCost | null;
  results?: ScanResultRow[];
}) {
  if (!cost || cost.state === "unavailable") return <NotAvailable />;

  const running = cost.state === "running";
  const perAnswerLine =
    cost.perAnswerUsd !== null
      ? `${cost.answers} answers · about ${formatUsd(cost.perAnswerUsd)} per answer`
      : `${cost.answers} answers · per-answer cost not available while some costs are unknown`;

  return (
    <Card data-slot="scan-cost-card">
      <CardHeader>
        <CardTitle>{running ? "Cost so far" : "Cost"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <div className="text-2xl font-semibold tabular-nums">
            {formatUsd(cost.totalAccountedUsd)}
          </div>
          <p className="text-sm text-muted-foreground">{perAnswerLine}</p>
        </div>

        {running && cost.heldUsd !== null ? (
          <p className="text-sm text-muted-foreground">
            {`This scan is still running. ${formatUsd(cost.heldUsd)} is reserved for it.`}
          </p>
        ) : null}

        {cost.unknownAttempts > 0 ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden />
            <AlertDescription>
              {`${cost.unknownAttempts} ${attemptsWord(cost.unknownAttempts)} did not report a cost. Each is counted at its ${formatUsd(cost.reservedUnknownUsd / cost.unknownAttempts)} reservation, so the total may be lower.`}
            </AlertDescription>
          </Alert>
        ) : null}

        {cost.byEngine.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Engine</TableHead>
                <TableHead>Answers</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Per answer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cost.byEngine.map((engine) => (
                <TableRow key={engine.engine}>
                  <TableCell>{engine.label}</TableCell>
                  <TableCell className="tabular-nums">{engine.answers}</TableCell>
                  <TableCell className="tabular-nums">{engine.attempts}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatUsd(engine.knownUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {engine.perAnswerUsd === null ? (
                      <Tooltip>
                        <TooltipTrigger
                          delay={150}
                          render={<span />}
                          aria-label="Not available while a cost is unknown"
                        >
                          —
                        </TooltipTrigger>
                        <TooltipContent>
                          Not available while a cost is unknown
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      formatUsd(engine.perAnswerUsd)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        <CostPerAnswer results={results} />
      </CardContent>
    </Card>
  );
}
