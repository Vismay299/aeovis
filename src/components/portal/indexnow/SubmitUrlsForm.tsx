"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/IndexNowSettings.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { splitUrls, pluralUrls, type SubmissionSource } from "@/shared/indexnow";
import { useIndexNowSubmit } from "./hooks/useIndexNowSubmit";

export type SubmitUrlsFormProps = {
  brandKey: string;
  domain: string;
  source?: SubmissionSource;
  sourceRef?: string;
  defaultUrls?: string[];
  limits?: {
    urlsToday: number;
    maxUrlsPerDay: number;
  };
  onRefreshKeyCheck?: () => void;
};

export function SubmitUrlsForm({
  brandKey,
  domain,
  source = "settings",
  sourceRef,
  defaultUrls = [],
  limits,
  onRefreshKeyCheck,
}: SubmitUrlsFormProps) {
  const [urlsText, setUrlsText] = useState(() => defaultUrls.join("\n"));
  const [validationError, setValidationError] = useState<string | null>(null);

  const submitMutation = useIndexNowSubmit(brandKey);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const urls = splitUrls(urlsText);
    if (urls.length === 0) {
      setValidationError("Enter at least one URL.");
      return;
    }

    try {
      const res = await submitMutation.mutateAsync({
        urls,
        source,
        sourceRef,
      });

      const failedHosts = res.hosts.filter((h) => h.status === "failed");
      for (const h of failedHosts) {
        toast.error("Couldn't submit to IndexNow", {
          description: h.message,
          duration: 10000,
        });
      }

      const submittedCount = res.hosts
        .filter((h) => h.status === "submitted")
        .reduce((sum, h) => sum + h.urlCount, 0);

      if (submittedCount > 0) {
        toast.success(`Submitted ${pluralUrls(submittedCount)}`);
      }

      const skippedOffsite = res.skipped.filter((s) => s.reason === "off_site");
      if (skippedOffsite.length > 0) {
        toast.warning(`Skipped ${pluralUrls(skippedOffsite.length)} not on ${domain}`);
      }

      const skippedRecent = res.skipped.filter(
        (s) => s.reason === "recently_submitted"
      );
      if (skippedRecent.length > 0) {
        toast.info(
          `Skipped ${pluralUrls(skippedRecent.length)} submitted in the last 10 minutes`
        );
      }

      // The textarea clears only when nothing failed and something was sent
      if (
        failedHosts.length === 0 &&
        (submittedCount > 0 || res.skipped.length > 0)
      ) {
        setUrlsText("");
      }

      // A failure refreshes the key-file check
      if (failedHosts.length > 0) {
        onRefreshKeyCheck?.();
      }
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to submit URLs";
      toast.error("Couldn't submit to IndexNow", {
        description: message,
        duration: 10000,
      });
      onRefreshKeyCheck?.();
    }
  }

  const urlsToday = limits?.urlsToday ?? 0;
  const maxUrlsPerDay = limits?.maxUrlsPerDay ?? 10000;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">
          Submit pages when you publish or update them
        </h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          Paste just the pages that changed, not your whole site.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="indexnow-urls">URLs (one per line)</Label>
        <Textarea
          id="indexnow-urls"
          name="urls"
          rows={4}
          placeholder={`https://${domain}/new-page`}
          value={urlsText}
          onChange={(e) => {
            setUrlsText(e.target.value);
            if (validationError) setValidationError(null);
          }}
          disabled={submitMutation.isPending}
          aria-invalid={Boolean(validationError)}
        />
        {validationError ? (
          <p className="text-xs text-destructive">{validationError}</p>
        ) : null}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <Button
          type="submit"
          disabled={submitMutation.isPending}
          className="w-full sm:w-auto"
        >
          {submitMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
          ) : null}
          Submit to IndexNow
        </Button>
        <p className="text-xs text-muted-foreground">
          Free. Up to {maxUrlsPerDay} URLs a day; {urlsToday} used today.
        </p>
      </div>
    </form>
  );
}
