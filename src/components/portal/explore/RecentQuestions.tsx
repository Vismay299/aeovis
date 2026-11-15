"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/PromptExplorerPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { MessagesSquare, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/app/EmptyState";
import { exploreModelLabel, type ExploreModel } from "@/shared/explore";
import { useRecentExploreRuns } from "./hooks/useExplore";

type Props = {
  brandKey: string;
  onSelectRun: (runId: string) => void;
};

function formatRunDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return isoDate;
  }
}

function statusBadge(status: string) {
  switch (status) {
    case "completed":
      return <Badge variant="secondary">Completed</Badge>;
    case "running":
      return <Badge variant="outline" className="border-sky-500 text-sky-600">Running</Badge>;
    case "queued":
      return <Badge variant="outline">Queued</Badge>;
    case "partial":
      return <Badge variant="warning">Partial</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "cancelled":
      return <Badge variant="secondary">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function RecentQuestions({ brandKey, onSelectRun }: Props) {
  const { data, isLoading, isError, refetch } = useRecentExploreRuns(brandKey);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Could not load recent questions.</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-4 mt-2">
          <span>Failed to fetch recent questions. Please try again.</span>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const runs = data?.runs ?? [];

  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            variant="plain"
            icon={MessagesSquare}
            title="Ask a question to compare model answers"
            description={
              <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1.5 text-left max-w-lg mx-auto mt-2">
                <li>
                  <span className="font-medium text-foreground">Models side by side</span> — Ask ChatGPT, Gemini and Perplexity at once and compare their answers.
                </li>
                <li>
                  <span className="font-medium text-foreground">See what the models cite</span> — Every answer lists the sources it used.
                </li>
                <li>
                  <span className="font-medium text-foreground">Check your brand</span> — See whether each answer names your brand.
                </li>
              </ul>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent questions</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          {runs.map((run: any) => (
            <button
              key={run.runId}
              type="button"
              onClick={() => onSelectRun(run.runId)}
              className="w-full text-left p-4 hover:bg-muted/50 transition-colors flex items-center justify-between gap-4 group"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-medium truncate text-foreground group-hover:text-primary transition-colors">
                  {run.prompt}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="hidden sm:inline-flex items-center gap-1">
                    {run.models.map((m: ExploreModel) => exploreModelLabel(m)).join(", ")}
                    <span>·</span>
                  </span>
                  <span>{formatRunDate(run.createdAt)}</span>
                </div>
              </div>
              <div className="shrink-0 hidden sm:block">
                {statusBadge(run.status)}
              </div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
