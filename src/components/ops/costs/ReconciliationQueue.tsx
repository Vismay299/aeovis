"use client";

/**
 * F03 §6.6.3 (6) — the open reconciliation queue and its single-row dialog.
 *
 * The dialog never changes an amount: `accepted` and `price_updated` close the
 * question, and `not_billed` zeroes a row that was never a paid call. A probe
 * attempt is reconciled from Measurement operations instead, so that option is
 * disabled here and says why.
 */

import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/app/FormDialog";
import { EmptyState } from "@/components/app/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { relativeTime } from "@/utils/format";
import { formatUsd } from "@/shared/money";
import type { OperatorCosts } from "@/shared/costs";
import { BulkAcceptDialog } from "./BulkAcceptDialog";

type ReconciliationRow = OperatorCosts["reconciliations"][number];
type Resolution = "accepted" | "price_updated" | "not_billed";

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: "accepted", label: "Accepted" },
  { value: "price_updated", label: "Price updated" },
  { value: "not_billed", label: "Not billed" },
];

const PROBE_HINT = "Use Measurement operations for answer attempts";

function usdOrDash(value: number | null): string {
  return value === null ? "—" : formatUsd(value);
}

function ResolveDialog({
  row,
  onClose,
  onResolved,
}: {
  row: ReconciliationRow;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [resolution, setResolution] = useState<Resolution>("accepted");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const noteReady = note.trim().length >= 10;
  const blocked = resolution === "not_billed" && row.isProbe;

  async function submit() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/ops/costs/reconciliations/${encodeURIComponent(row.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolution, note: note.trim() }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "The reconciliation could not be resolved.");
      }
      toast.success("Resolved");
      onResolved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The reconciliation could not be resolved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog
      title="Resolve reconciliation"
      onClose={onClose}
      pending={pending}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={pending}
            disabled={!noteReady || blocked}
          >
            Resolve
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Resolution</legend>
          {RESOLUTIONS.map((option) => {
            const disabled = option.value === "not_billed" && row.isProbe;
            return (
              <div key={option.value} className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="resolution"
                    value={option.value}
                    checked={resolution === option.value}
                    disabled={disabled || pending}
                    onChange={() => setResolution(option.value)}
                    className="size-4 accent-primary"
                  />
                  {option.label}
                </label>
                {disabled ? (
                  <p className="pl-6 text-xs text-muted-foreground">{PROBE_HINT}</p>
                ) : null}
              </div>
            );
          })}
        </fieldset>

        <div className="space-y-1.5">
          <label htmlFor="resolve-note" className="text-sm font-medium">
            Note
          </label>
          <Textarea
            id="resolve-note"
            value={note}
            rows={3}
            placeholder="Add a note of at least 10 characters."
            onChange={(event) => setNote(event.target.value)}
          />
          {note.length > 0 && !noteReady ? (
            <p className="text-xs text-destructive">
              Add a note of at least 10 characters.
            </p>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </FormDialog>
  );
}

export function ReconciliationQueue({
  rows,
  onResolved,
}: {
  rows: ReconciliationRow[];
  onResolved: () => void;
}) {
  const [resolving, setResolving] = useState<ReconciliationRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const unknownCount = rows.filter((row) => row.kind === "unknown_cost").length;

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle>Reconciliation queue</CardTitle>
        <p className="text-sm text-muted-foreground">
          {`${rows.length} open · ${unknownCount} unknown cost`}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {unknownCount > 0 ? (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setBulkOpen(true)}>
              Accept unknown costs older than…
            </Button>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState variant="plain" size="sm" title="No open reconciliations" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Estimate</TableHead>
                <TableHead>Actual</TableHead>
                <TableHead>Price version</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">
                    {relativeTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium">{row.brandKey}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2">
                      {row.kind}
                      {row.isProbe ? (
                        <Badge variant="outline">Probe attempt</Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>{row.provider}</TableCell>
                  <TableCell>{row.endpoint}</TableCell>
                  <TableCell className="tabular-nums">
                    {usdOrDash(row.estimateUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {usdOrDash(row.actualUsd)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.priceVersion ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Resolve ${row.endpoint}`}
                      onClick={() => setResolving(row)}
                    >
                      Resolve
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {resolving ? (
        <ResolveDialog
          row={resolving}
          onClose={() => setResolving(null)}
          onResolved={onResolved}
        />
      ) : null}

      {bulkOpen ? (
        <BulkAcceptDialog
          rows={rows}
          onClose={() => setBulkOpen(false)}
          onResolved={onResolved}
        />
      ) : null}
    </Card>
  );
}
