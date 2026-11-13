"use client";

// F19 phase 3 — bulk "Submit to IndexNow" dialog launched from the audit pages table.

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { FormDialog } from "@/components/app/FormDialog";
import { useIndexNowSetup } from "./hooks/useIndexNowSetup";
import { useIndexNowSubmit } from "./hooks/useIndexNowSubmit";
import type { IndexNowHostResult, IndexNowSkippedUrl } from "./hooks/useIndexNowSubmit";
import type { AuditPageRef } from "@/components/portal/audit/pageActions";

export type SubmitIndexNowDialogProps = {
  brandKey: string;
  auditId: string;
  pages: AuditPageRef[];
  onClose: () => void;
};

export function SubmitIndexNowDialog({
  brandKey,
  auditId,
  pages,
  onClose,
}: SubmitIndexNowDialogProps) {
  const setup = useIndexNowSetup(brandKey);
  const submit = useIndexNowSubmit(brandKey);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<{
    hosts: IndexNowHostResult[];
    skipped: IndexNowSkippedUrl[];
  } | null>(null);

  const eligible = pages.filter(
    (p) =>
      p.statusCode !== null &&
      p.statusCode >= 200 &&
      p.statusCode < 300 &&
      p.indexable !== false,
  );
  const ineligibleCount = pages.length - eligible.length;
  const urls = eligible.map((p) => p.url);
  const needsConfirm = eligible.length > 100;
  const ready = setup.data?.ready ?? false;

  async function handleSubmit() {
    if (eligible.length === 0) return;
    if (needsConfirm && !confirmed) return;
    try {
      const res = await submit.mutateAsync({
        urls,
        source: "audit",
        sourceRef: auditId,
      });
      setResult({ hosts: res.hosts, skipped: res.skipped });
    } catch {
      // error surfaced via submit.error below
    }
  }

  const titleCount = eligible.length;
  const titleWord = titleCount === 1 ? "page" : "pages";

  return (
    <FormDialog
      title={`Submit ${titleCount} ${titleWord} to IndexNow`}
      onClose={onClose}
      pending={submit.isPending}
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submit.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              !ready ||
              submit.isPending ||
              eligible.length === 0 ||
              (needsConfirm && !confirmed)
            }
          >
            {submit.isPending ? (
              <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
            ) : null}
            Submit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Submit only pages you added or changed since search engines last
          crawled them. Resubmitting unchanged pages can get your submissions
          ignored.
        </p>
        {ineligibleCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {ineligibleCount} pages were left out because they didn&apos;t load
            or are marked noindex.
          </p>
        ) : null}
        <ul className="space-y-1 text-xs font-mono break-all">
          {eligible.slice(0, 5).map((p) => (
            <li key={p.url}>{p.url}</li>
          ))}
        </ul>
        {eligible.length > 5 ? (
          <p className="text-xs text-muted-foreground">
            +{eligible.length - 5} more
          </p>
        ) : null}
        {!ready && !setup.isLoading ? (
          <Alert variant="info">
            <AlertTitle>Your key file isn&apos;t verified yet.</AlertTitle>
            <AlertDescription>
              <Link
                href="/portal/settings/indexnow"
                className="text-primary underline hover:text-foreground font-medium"
              >
                Open IndexNow settings
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}
        {needsConfirm ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
            />
            I changed all {eligible.length} of these pages.
          </label>
        ) : null}
        {submit.isError ? (
          <p className="text-xs text-destructive">
            {submit.error instanceof Error
              ? submit.error.message
              : "Couldn't submit to IndexNow"}
          </p>
        ) : null}
        {result ? (
          <div className="space-y-2">
            {result.hosts.map((h) => (
              <p key={h.host} className="text-sm">
                {h.status === "submitted" ? "Submitted" : "Failed"}:{" "}
                {h.message}
              </p>
            ))}
            {result.skipped.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Skipped {result.skipped.length} URLs
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}

export default SubmitIndexNowDialog;