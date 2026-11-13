// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/launch/LaunchFormCard.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the "Start new audit" card: URL, page limit, the two paid
// option switches, the free-crawl note and the form errors.

import { Loader2 } from "lucide-react";
import { formatUsd } from "@/shared/pricing";
import { Button } from "@/components/ui/button";
import { CardShell } from "@/components/app/CardShell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LIGHTHOUSE_LIVE_USD } from "@/lib/pricing/dataforseo";
import { firecrawlScrapeUsd } from "@/lib/pricing/firecrawl";
import type { LaunchController } from "./useLaunchController";

export function LaunchFormCard({
  controller,
  websiteHost,
  renderAvailable,
}: {
  controller: LaunchController;
  websiteHost: string;
  renderAvailable: boolean;
}) {
  const {
    capabilities,
    startUrl,
    setStartUrl,
    maxPagesText,
    setMaxPagesText,
    commitMaxPages,
    maxPages,
    maxPagesLimit,
    renderedLimit,
    lighthouse,
    setLighthouse,
    renderJavaScript,
    setRenderJavaScript,
    fieldError,
    formError,
    submit,
    pending,
  } = controller;
  const renderConfigured =
    capabilities?.renderReason !== "not_configured" && Boolean(capabilities?.render);
  const renderUnit = firecrawlScrapeUsd();

  return (
    <CardShell title="Start new audit">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 lg:grid-cols-12">
          <div className="space-y-1 lg:col-span-9">
            <Input
              aria-label="Site URL"
              aria-invalid={fieldError ? true : undefined}
              placeholder={`https://${websiteHost}`}
              value={startUrl}
              onChange={(event) => setStartUrl(event.target.value)}
              autoComplete="url"
            />
            {fieldError ? (
              <p role="alert" className="text-sm text-destructive">
                {fieldError}
              </p>
            ) : null}
          </div>
          <div className="lg:col-span-3">
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {pending ? "Starting…" : "Start audit"}
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1 rounded-lg border border-border p-3">
            <Label htmlFor="audit-max-pages">Max pages</Label>
            <Input
              id="audit-max-pages"
              inputMode="numeric"
              className="w-28"
              value={maxPagesText}
              onChange={(event) =>
                setMaxPagesText(event.target.value.replace(/[^\d]/g, ""))
              }
              onBlur={commitMaxPages}
            />
            <p className="text-xs text-muted-foreground">
              {`Enter any value from 10 to ${maxPagesLimit}.`}
              {renderJavaScript
                ? ` Audits that render JavaScript are limited to ${renderedLimit.toLocaleString("en-US")} pages.`
                : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {`${(capabilities?.monthlyPagesUsed ?? 0).toLocaleString("en-US")} of ${(capabilities?.monthlyPagesCap ?? 0).toLocaleString("en-US")} audit pages used this month.`}
            </p>
          </div>

          <div className="space-y-3">
            {capabilities?.lighthouse ? (
              <div className="space-y-1 rounded-lg border border-border p-3">
                <label
                  className="flex items-center gap-2 text-sm font-medium"
                  title="Lighthouse measures page speed, accessibility and SEO."
                >
                  <Switch
                    checked={lighthouse}
                    onCheckedChange={(checked) => setLighthouse(Boolean(checked))}
                    aria-label="Include Lighthouse"
                  />
                  Include Lighthouse
                </label>
                {lighthouse ? (
                  <p className="text-xs text-muted-foreground">
                    {`We test up to 10 pages, one per page template, on mobile and desktop: up to 20 checks, at most ${formatUsd(20 * LIGHTHOUSE_LIVE_USD)}.`}
                  </p>
                ) : null}
              </div>
            ) : null}

            {renderAvailable ? (
              <div className="space-y-1 rounded-lg border border-border p-3">
                <label
                  className="flex items-center gap-2 text-sm font-medium"
                  title="Loads each page in a browser before auditing it. Slower."
                >
                  <Switch
                    checked={renderJavaScript}
                    disabled={!renderConfigured}
                    onCheckedChange={(checked) =>
                      setRenderJavaScript(Boolean(checked))
                    }
                    aria-label="Render JavaScript"
                  />
                  Render JavaScript
                </label>
                {!renderConfigured ? (
                  <p className="text-xs text-muted-foreground">
                    JavaScript rendering isn't available right now.
                  </p>
                ) : renderJavaScript ? (
                  <p className="text-xs text-muted-foreground">
                    {`Up to ${formatUsd(maxPages * renderUnit)} for up to ${maxPages.toLocaleString("en-US")} pages. Each page is loaded by a browser service; you pay only for pages it loads.`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Crawling is free. Lighthouse and JavaScript rendering cost money;
          you'll see the price before the audit starts.
        </p>

        {formError ? (
          <Alert variant="destructive">
            <AlertTitle>{formError.message}</AlertTitle>
            <AlertDescription className="space-y-2">
              {formError.activeAuditId ? (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={
                    <a href={`/portal/audit/${formError.activeAuditId}`} />
                  }
                >
                  Open the running audit
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </form>
    </CardShell>
  );
}
