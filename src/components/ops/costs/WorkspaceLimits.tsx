"use client";

/**
 * F03 §6.6.3 (8) — a workspace's daily and monthly spend caps.
 *
 * Search names the workspace, then the two caps are set together so clearing a
 * field really means "no cap" rather than "keep the ceiling that was there".
 */

import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/app/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/shared/format";
import { formatUsd } from "@/shared/money";

/** One row of `GET /api/ops/spend/limits`. */
export type SpendLimit = {
  brandKey: string;
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  updatedAt: string;
};

function parseUsd(value: string): { ok: boolean; value: number | null } {
  if (value.trim() === "") return { ok: true, value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return { ok: false, value: null };
  return { ok: true, value: parsed };
}

function usdOrDash(value: number | null): string {
  return value === null ? "—" : formatUsd(value);
}

export function WorkspaceLimits({
  limits,
  onSaved,
}: {
  limits: SpendLimit[];
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [dailyCap, setDailyCap] = useState("");
  const [monthlyCap, setMonthlyCap] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const brandKey = search.trim();
  const daily = parseUsd(dailyCap);
  const monthly = parseUsd(monthlyCap);
  const visible = limits.filter(
    (row) =>
      brandKey === "" ||
      row.brandKey.toLowerCase().includes(brandKey.toLowerCase()),
  );

  function edit(row: SpendLimit) {
    setSearch(row.brandKey);
    setDailyCap(row.dailyCapUsd === null ? "" : String(row.dailyCapUsd));
    setMonthlyCap(row.monthlyCapUsd === null ? "" : String(row.monthlyCapUsd));
    setError("");
  }

  async function save() {
    if (!brandKey) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/ops/spend/limits/${encodeURIComponent(brandKey)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dailyCapUsd: daily.value,
            monthlyCapUsd: monthly.value,
          }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "The limits could not be saved.");
      }
      toast.success("Saved");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The limits could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace limits</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="limits-search">Workspace brand key</Label>
          <Input
            id="limits-search"
            type="search"
            value={search}
            placeholder="Search by brand key"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="limits-daily">Daily cap</Label>
            <Input
              id="limits-daily"
              type="number"
              min={0}
              step="0.01"
              value={dailyCap}
              placeholder="Leave empty for no limit"
              onChange={(event) => setDailyCap(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="limits-monthly">Monthly cap</Label>
            <Input
              id="limits-monthly"
              type="number"
              min={0}
              step="0.01"
              value={monthlyCap}
              placeholder="Leave empty for no limit"
              onChange={(event) => setMonthlyCap(event.target.value)}
            />
          </div>
        </div>

        {!daily.ok || !monthly.ok ? (
          <p className="text-xs text-destructive">
            Enter a cap of 0 or more, or leave the field empty for no limit.
          </p>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div>
          <Button
            onClick={() => void save()}
            pending={pending}
            disabled={!brandKey || !daily.ok || !monthly.ok}
          >
            Save
          </Button>
        </div>

        {visible.length === 0 ? (
          <EmptyState variant="plain" size="sm" title="No workspace limits set" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Daily cap</TableHead>
                <TableHead>Monthly cap</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.brandKey}>
                  <TableCell className="font-medium">{row.brandKey}</TableCell>
                  <TableCell className="tabular-nums">
                    {usdOrDash(row.dailyCapUsd)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {usdOrDash(row.monthlyCapUsd)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {relativeTime(row.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Edit ${row.brandKey}`}
                      onClick={() => edit(row)}
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
    </Card>
  );
}
