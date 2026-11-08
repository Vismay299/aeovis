"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/IndexNowSettings.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { CardShell } from "@/components/app/CardShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import { useIndexNowSetup, useIndexNowSetupMutation } from "./hooks/useIndexNowSetup";
import { KeyFileStep } from "./KeyFileStep";
import { SubmitUrlsForm } from "./SubmitUrlsForm";
import { SubmissionHistory } from "./SubmissionHistory";

export function IndexNowSettings() {
  const workspace = useWorkspace();
  const brandKey = workspace?.brandKey ?? "";

  const { data, isLoading, error, refetch } = useIndexNowSetup(brandKey);
  const setupMutation = useIndexNowSetupMutation(brandKey);
  const [setupError, setSetupError] = useState<string | null>(null);

  async function handleSetup() {
    setSetupError(null);
    try {
      await setupMutation.mutateAsync();
      await refetch();
    } catch (err: unknown) {
      if (err && typeof err === "object" && "message" in err) {
        setSetupError(String((err as { message: string }).message));
      } else {
        setSetupError("Failed to set up IndexNow.");
      }
    }
  }

  return (
    <section id="indexnow">
      <CardShell title="IndexNow">
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Tell Bing about new and updated pages as soon as you publish them,
            instead of waiting for it to crawl your site. Bing shares
            submissions with Yandex, Seznam, Naver and Yep, and powers
            DuckDuckGo and Yahoo results. Google doesn&apos;t use IndexNow.
          </p>

          {isLoading ? (
            <div className="space-y-2 pt-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : error ? (
            <div className="space-y-2 pt-2">
              <p className="text-sm text-destructive">
                Couldn&apos;t load IndexNow.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            </div>
          ) : !data?.key ? (
            <div className="space-y-4 pt-2 border-t border-border">
              <p className="text-sm">
                Get a key for {data?.domain ?? brandKey}, add it to your site
                once, then submit pages whenever you publish or update them.
              </p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSetup}
                  disabled={setupMutation.isPending}
                >
                  {setupMutation.isPending ? (
                    <Loader2
                      className="size-4 animate-spin"
                      data-icon="inline-start"
                    />
                  ) : null}
                  Set up IndexNow
                </Button>
                {setupError ? (
                  <p className="text-xs text-destructive mt-1.5">{setupError}</p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="space-y-8 pt-2 border-t border-border">
              <KeyFileStep
                brandKey={brandKey}
                domain={data.domain}
                indexNowKey={data.key}
                hosts={data.hosts}
                checkedAt={data.checkedAt}
                ready={data.ready}
                onCheckSuccess={() => void refetch()}
              />

              <div className="border-t border-border pt-6">
                <SubmitUrlsForm
                  brandKey={brandKey}
                  domain={data.domain}
                  source="settings"
                  limits={data.limits}
                  onRefreshKeyCheck={() => void refetch()}
                />
              </div>

              <div className="border-t border-border pt-6">
                <SubmissionHistory brandKey={brandKey} />
              </div>
            </div>
          )}
        </div>
      </CardShell>
    </section>
  );
}
