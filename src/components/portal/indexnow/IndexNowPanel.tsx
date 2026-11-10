"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/IndexNowSettings.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { CardShell } from "@/components/app/CardShell";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import type { SubmissionSource } from "@/shared/indexnow";
import { useIndexNowSetup } from "./hooks/useIndexNowSetup";
import { SubmitUrlsForm } from "./SubmitUrlsForm";
import { SubmissionHistory } from "./SubmissionHistory";

export type IndexNowPanelProps = {
  source: Extract<SubmissionSource, "audit" | "content">;
  sourceRef?: string;
  defaultUrls?: string[];
  title?: string;
};

export function IndexNowPanel({
  source,
  sourceRef,
  defaultUrls,
  title = "IndexNow",
}: IndexNowPanelProps) {
  const workspace = useWorkspace();
  const brandKey = workspace?.brandKey ?? "";

  const { data, isLoading, error, refetch } = useIndexNowSetup(brandKey);

  const verifiedHost =
    data?.hosts?.find((h) => h.status === "found")?.host ??
    data?.domain ??
    brandKey;

  return (
    <CardShell title={title}>
      <div className="space-y-6">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load IndexNow.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              {data?.ready ? (
                <>
                  <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500 shrink-0" />
                  <span className="text-muted-foreground">
                    Key file verified on {verifiedHost}
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="size-4 text-destructive shrink-0" />
                  <span className="text-muted-foreground">
                    Key file not verified. Set it up in{" "}
                    <Link
                      href="/portal/settings/indexnow"
                      className="text-primary underline hover:text-foreground font-medium"
                    >
                      Workspace settings
                    </Link>
                    .
                  </span>
                </>
              )}
            </div>

            <div className="border-t border-border pt-6">
              <SubmitUrlsForm
                brandKey={brandKey}
                domain={data?.domain ?? brandKey}
                source={source}
                sourceRef={sourceRef}
                defaultUrls={defaultUrls}
                limits={data?.limits}
                onRefreshKeyCheck={() => void refetch()}
              />
            </div>

            <div className="border-t border-border pt-6">
              <SubmissionHistory
                brandKey={brandKey}
                source={source}
                sourceRef={sourceRef}
              />
            </div>
          </>
        )}
      </div>
    </CardShell>
  );
}
