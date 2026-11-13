"use client";

/**
 * F03 §6.6.3 (7) — F01's paid-feature controls, edited here.
 *
 * This page changes spend controls only. It never touches dispatch rollout:
 * there is no probe-rollout action on it, by design (F03 hard rule).
 */

import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/app/FormDialog";
import { EmptyState } from "@/components/app/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

/** One row of `GET /api/ops/spend/controls`. */
export type SpendControl = {
  feature: string;
  enabled: boolean;
  mode: "all" | "allowlist";
  brandAllowlist: string[];
  dailyCapUsd: number | null;
  maxCallUsd: number | null;
  note: string | null;
  updatedAt: string;
};

type Mode = SpendControl["mode"];

const MODES: { value: Mode; label: string }[] = [
  { value: "all", label: "All workspaces" },
  { value: "allowlist", label: "Allowlist" },
];

/** An empty field means "no cap"; anything else must be a number. */
function parseUsd(value: string): { ok: boolean; value: number | null } {
  if (value.trim() === "") return { ok: true, value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return { ok: false, value: null };
  return { ok: true, value: parsed };
}

function usdOrDash(value: number | null): string {
  return value === null ? "—" : formatUsd(value);
}

function EditControlDialog({
  control,
  onClose,
  onSaved,
}: {
  control: SpendControl;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(control.enabled);
  const [mode, setMode] = useState<Mode>(control.mode);
  const [allowlist, setAllowlist] = useState(control.brandAllowlist.join(", "));
  const [dailyCap, setDailyCap] = useState(
    control.dailyCapUsd === null ? "" : String(control.dailyCapUsd),
  );
  const [maxCall, setMaxCall] = useState(
    control.maxCallUsd === null ? "" : String(control.maxCallUsd),
  );
  const [note, setNote] = useState(control.note ?? "");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const daily = parseUsd(dailyCap);
  const perCall = parseUsd(maxCall);
  const confirmed = confirm === control.feature;

  async function submit() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/ops/spend/controls/${encodeURIComponent(control.feature)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            mode,
            brandAllowlist: allowlist
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean),
            dailyCapUsd: daily.value,
            maxCallUsd: perCall.value,
            note: note.trim() === "" ? null : note.trim(),
            confirm,
          }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "The control could not be saved.");
      }
      toast.success("Saved");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The control could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog
      title={`Edit ${control.feature}`}
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
            disabled={!confirmed || !daily.ok || !perCall.ok}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="control-enabled">Enabled</Label>
          <Switch
            id="control-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Enabled"
          />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Mode</legend>
          {MODES.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="control-mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
                className="size-4 accent-primary"
              />
              {option.label}
            </label>
          ))}
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor="control-allowlist">Allowlist</Label>
          <Input
            id="control-allowlist"
            value={allowlist}
            placeholder="brand-key, another-brand-key"
            onChange={(event) => setAllowlist(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated brand keys. Used when the mode is Allowlist.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="control-daily-cap">Daily cap</Label>
            <Input
              id="control-daily-cap"
              type="number"
              min={0}
              step="0.01"
              value={dailyCap}
              placeholder="No cap"
              onChange={(event) => setDailyCap(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="control-max-call">Max per call</Label>
            <Input
              id="control-max-call"
              type="number"
              min={0}
              step="0.0001"
              value={maxCall}
              placeholder="No cap"
              onChange={(event) => setMaxCall(event.target.value)}
            />
          </div>
        </div>
        {!daily.ok || !perCall.ok ? (
          <p className="text-xs text-destructive">
            Enter a cap of 0 or more, or leave the field empty for no cap.
          </p>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="control-note">Note</Label>
          <Textarea
            id="control-note"
            value={note}
            rows={2}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="control-confirm">
            {`Type ${control.feature} to confirm`}
          </Label>
          <Input
            id="control-confirm"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
          />
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

export function PaidFeatureControls({
  controls,
  onSaved,
}: {
  controls: SpendControl[];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState<SpendControl | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Paid features</CardTitle>
      </CardHeader>
      <CardContent>
        {controls.length === 0 ? (
          <EmptyState variant="plain" size="sm" title="No paid features registered" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Daily cap</TableHead>
                <TableHead>Max per call</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {controls.map((control) => (
                <TableRow key={control.feature}>
                  <TableCell className="font-medium">{control.feature}</TableCell>
                  <TableCell>
                    {control.enabled ? (
                      <Badge variant="success">On</Badge>
                    ) : (
                      <Badge variant="outline">Off</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {control.mode === "all" ? "All workspaces" : "Allowlist"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {usdOrDash(control.dailyCapUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {usdOrDash(control.maxCallUsd)}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {control.note || "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {relativeTime(control.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Edit ${control.feature}`}
                      onClick={() => setEditing(control)}
                    >
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {editing ? (
        <EditControlDialog
          key={editing.feature}
          control={editing}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      ) : null}
    </Card>
  );
}
