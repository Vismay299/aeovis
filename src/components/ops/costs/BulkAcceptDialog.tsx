"use client";

/**
 * F03 §6.6.3 (6) — accept the open unknown-cost backlog past a cutoff.
 *
 * The dialog works from a cutoff, never from the visible selection, because the
 * queue lists at most 200 rows while the backlog is larger. It can only mark
 * rows `accepted`: it never rewrites an amount, so it cannot be used to zero
 * spend.
 */

import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/app/FormDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorCosts } from "@/shared/costs";

type ReconciliationRow = OperatorCosts["reconciliations"][number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The route's own limit, so a bad value is caught before the request. */
function validDays(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 400;
}

export function BulkAcceptDialog({
  rows,
  onClose,
  onResolved,
}: {
  /** Every open reconciliation currently loaded. */
  rows: ReconciliationRow[];
  onClose: () => void;
  onResolved: () => void;
}) {
  const [days, setDays] = useState(7);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const cutoff = Date.now() - days * DAY_MS;
  const count = rows.filter(
    (row) =>
      row.kind === "unknown_cost" &&
      new Date(row.createdAt).getTime() <= cutoff,
  ).length;
  const noteReady = note.trim().length >= 10;

  async function submit() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/ops/costs/reconciliations/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "unknown_cost",
          beforeDays: days,
          note: note.trim(),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "The backlog could not be accepted.");
      }
      toast.success("Resolved");
      onResolved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The backlog could not be accepted.");
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog
      title="Accept unknown costs older than…"
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
            disabled={!noteReady || !validDays(days)}
          >
            Accept
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="bulk-days">Days</Label>
          <Input
            id="bulk-days"
            type="number"
            min={1}
            max={400}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            {`${count} open unknown-cost ${count === 1 ? "row is" : "rows are"} older than ${days} ${days === 1 ? "day" : "days"}. Only rows marked accepted; no amount changes.`}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bulk-note">Note</Label>
          <Textarea
            id="bulk-note"
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
