// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/reports/shared.tsx:110-253
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useId, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { describeError } from "@/shared/query/errors";
import { relativeTime } from "@/shared/format";
import { useShareReport } from "./hooks/useReports.ts";
import { describeViews } from "./shareState.ts";
import type { ReportDetailItem } from "./hooks/useReports.ts";

// The share toggle. The link is built from the browser's own origin, so the
// same report shares correctly from every deployment without the server
// knowing any hostname.
export function ShareReportDialog({
  brandKey,
  report,
  onClose,
}: {
  brandKey: string;
  report: Pick<
    ReportDetailItem,
    "id" | "title" | "shareToken" | "sharedAt" | "views30d"
  >;
  onClose: () => void;
}) {
  const switchId = useId();
  const [token, setToken] = useState<string | null>(report.shareToken);
  const [sharedAt, setSharedAt] = useState<string | null>(report.sharedAt);
  const shareMutation = useShareReport(brandKey, report.id);

  const shared = token !== null;
  // The toggle follows the click while the mutation is in flight — a round
  // trip that leaves the switch sitting in its old position reads as broken.
  const checked = shareMutation.isPending
    ? (shareMutation.variables ?? shared)
    : shared;
  const turningOff = shareMutation.isPending && shareMutation.variables === false;
  const url = token ? `${window.location.origin}/s/${token}` : "";

  const toggle = (next: boolean) => {
    shareMutation.mutate(next, {
      onSuccess: (result) => {
        setToken(result.shareToken);
        setSharedAt(result.sharedAt);
      },
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Clipboard not available");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        fullScreenOnMobile
      >
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>Share</DialogTitle>
          <DialogDescription className="truncate">
            {report.title}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border">
          <Field orientation="horizontal" className="p-4">
            <FieldContent>
              <FieldLabel htmlFor={switchId}>Public link</FieldLabel>
              <FieldDescription id={`${switchId}-description`}>
                {shared
                  ? "Anyone with the link can view. No sign-in needed."
                  : turningOff
                    ? "Only members of this workspace can open it. A link that was public can keep loading for up to a minute."
                    : "Only members of this workspace can open it."}
              </FieldDescription>
            </FieldContent>
            <Switch
              id={switchId}
              aria-describedby={`${switchId}-description`}
              checked={checked}
              disabled={shareMutation.isPending}
              onCheckedChange={toggle}
            />
          </Field>

          {shared ? null : (
            <div className="border-t border-border p-4">
              <Alert variant="info">
                <AlertDescription>
                  Check the report before you share it. It was written by an
                  AI assistant from your data and from other websites.
                </AlertDescription>
              </Alert>
            </div>
          )}

          {shared ? (
            <div className="space-y-3 border-t border-border p-4">
              {/* The field wraps onto its own line when the row gets narrow,
                  so the link stays readable on a phone instead of shrinking. */}
              <div className="flex flex-wrap items-stretch gap-2">
                <Input
                  readOnly
                  value={url}
                  aria-label="Share link"
                  onFocus={(event) => event.target.select()}
                  className="min-w-0 flex-1 basis-64"
                />
                <div className="flex items-stretch gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Open link"
                    title="Open"
                    onClick={() => window.open(url, "_blank", "noopener")}
                  >
                    <ExternalLink />
                  </Button>
                  <Button onClick={() => void copy()}>
                    <Copy data-icon="inline-start" />
                    Copy link
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Shows the latest saved version. Hidden from search engines.
                {sharedAt
                  ? ` Link created ${relativeTime(sharedAt)}.`
                  : ""}
                {report.views30d !== null && report.views30d !== undefined
                  ? ` ${describeViews(report.views30d)}`
                  : ""}
              </p>
            </div>
          ) : null}
        </div>

        {/* Shown in place rather than as a toast: the message belongs next to
            the toggle that would not move. */}
        {shareMutation.isError ? (
          <p className="text-sm text-destructive">
            {describeError(shareMutation.error, "Failed to update sharing")}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
