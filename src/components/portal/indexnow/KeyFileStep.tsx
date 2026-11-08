"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/IndexNowSettings.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import {
  Download,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { CopyButton } from "@/components/app/CopyButton";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import {
  KEY_FILE_LABELS,
  isUnusedHost,
  isProblemStatus,
  type KeyFileStatus,
} from "@/shared/indexnow";
import { useIndexNowCheck } from "./hooks/useIndexNowCheck";

export type KeyFileStepProps = {
  brandKey: string;
  domain: string;
  indexNowKey: string;
  hosts: Array<{ host: string; status: KeyFileStatus }> | null;
  checkedAt: string | null;
  ready: boolean;
  onCheckSuccess?: () => void;
};

export function KeyFileStep({
  brandKey,
  domain,
  indexNowKey,
  hosts,
  checkedAt,
  ready,
  onCheckSuccess,
}: KeyFileStepProps) {
  const [howToOpen, setHowToOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const checkMutation = useIndexNowCheck(brandKey);

  function handleDownload() {
    const blob = new Blob([indexNowKey], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${indexNowKey}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleCheckAgain() {
    setErrorMessage(null);
    try {
      await checkMutation.mutateAsync({ force: true });
      onCheckSuccess?.();
    } catch (err: unknown) {
      if (err && typeof err === "object" && "message" in err) {
        setErrorMessage(String((err as { message: string }).message));
      } else {
        setErrorMessage("Couldn't check right now");
      }
    }
  }

  const rawHostList =
    hosts ?? [
      { host: domain, status: "unknown" as KeyFileStatus },
      { host: `www.${domain}`, status: "unknown" as KeyFileStatus },
    ];

  // hosts with moved/unreachable are hidden when another host is used
  const hasUsed = hosts
    ? hosts.some((h) => !isUnusedHost(h.status))
    : false;
  const visibleHosts =
    hasUsed && hosts
      ? hosts.filter((h) => !isUnusedHost(h.status))
      : rawHostList;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">
          {ready
            ? "Your key file is set up"
            : "Add this key file to your site"}
        </h3>
      </div>

      {!ready ? (
        <div className="space-y-3">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDownload}
            >
              <Download className="size-4" data-icon="inline-start" />
              Download key file
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Put it at the root of your site, so it opens at:
          </p>
        </div>
      ) : null}

      <ul className="space-y-2">
        {visibleHosts.map((h) => {
          const fileUrl = `https://${h.host}/${indexNowKey}.txt`;
          const hasCheck = Boolean(checkedAt && hosts);

          return (
            <li
              key={h.host}
              className="flex items-center gap-2.5 text-sm flex-wrap"
            >
              <SafeExternalLink
                url={fileUrl}
                label={fileUrl}
                className="font-mono text-xs text-primary underline inline-flex items-center gap-1 break-all"
              />
              {hasCheck ? (
                <span className="inline-flex items-center gap-1 text-xs">
                  {h.status === "found" ? (
                    <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-500 shrink-0" />
                  ) : isProblemStatus(h.status) ? (
                    <XCircle className="size-3.5 text-destructive shrink-0" />
                  ) : (
                    <HelpCircle className="size-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span
                    className={
                      h.status === "found"
                        ? "text-emerald-600 dark:text-emerald-500 font-medium"
                        : isProblemStatus(h.status)
                          ? "text-destructive font-medium"
                          : "text-muted-foreground"
                    }
                  >
                    {KEY_FILE_LABELS[h.status] ?? h.status}
                  </span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2 text-sm flex-wrap">
        <span>
          Key:{" "}
          <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {indexNowKey}
          </code>
        </span>
        <CopyButton
          value={indexNowKey}
          label="Copy key"
          successMessage="Key copied"
          size="xs"
        />
      </div>

      <div className="space-y-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={handleCheckAgain}
          disabled={checkMutation.isPending}
        >
          {checkMutation.isPending ? (
            <Loader2 className="size-3 animate-spin" data-icon="inline-start" />
          ) : null}
          Check again
        </Button>
        {errorMessage ? (
          <p className="text-xs text-destructive">{errorMessage}</p>
        ) : null}
      </div>

      <Collapsible open={howToOpen} onOpenChange={setHowToOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-medium transition-colors">
          <ChevronDown
            className={`size-3 transition-transform ${howToOpen ? "rotate-180" : ""}`}
          />
          How do I add a file to my site?
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="list-disc pl-5 space-y-1.5 text-xs text-muted-foreground mt-2">
            <li>
              Site built from code: put the file in the folder your site serves
              as-is, often called public or static.
            </li>
            <li>
              WordPress: upload it with your host&apos;s file manager or SFTP to
              the folder that holds wp-config.php. SEO plugins like Rank Math can
              also submit to IndexNow for you.
            </li>
            <li>
              On Cloudflare: turn on Crawler Hints in Cloudflare&apos;s caching
              settings and it submits changed pages to IndexNow for you.
            </li>
            <li>
              Website builders like Webflow, Shopify, Squarespace and Wix
              usually don&apos;t let you add files at the root. Check whether
              yours already supports IndexNow.
            </li>
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
