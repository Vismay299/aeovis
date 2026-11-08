"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/IndexNowSettings.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SUBMISSION_SOURCE_LABELS,
  ENGINE_LABELS,
  pluralUrls,
  type SubmissionSource,
} from "@/shared/indexnow";
import { useIndexNowSubmissions } from "./hooks/useIndexNowSubmissions";

export type SubmissionHistoryProps = {
  brandKey: string;
  source?: SubmissionSource;
  sourceRef?: string;
  limit?: number;
};

function formatIso(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function SubmissionHistory({
  brandKey,
  source,
  sourceRef,
  limit = 20,
}: SubmissionHistoryProps) {
  const { data, isLoading, error } = useIndexNowSubmissions(brandKey, {
    source,
    sourceRef,
    limit,
  });

  const submissions = data?.submissions ?? [];

  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold">Recent submissions</h3>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">Couldn&apos;t load submissions.</p>
      ) : submissions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing submitted yet.</p>
      ) : (
        <Table containerClassName="rounded-md border border-border">
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>URLs</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {submissions.map((item) => {
              const engineName =
                item.engine && ENGINE_LABELS[item.engine]
                  ? ENGINE_LABELS[item.engine]
                  : "Bing";
              const resultText =
                item.status === "submitted"
                  ? `Submitted via ${engineName}`
                  : `Failed: ${item.message}`;

              return (
                <TableRow key={item.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatIso(item.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {SUBMISSION_SOURCE_LABELS[item.source] ?? item.source}
                  </TableCell>
                  <TableCell className="text-xs font-mono whitespace-nowrap">
                    {item.host}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span title={item.urls.join(", ")}>
                      {pluralUrls(item.urlCount)}
                    </span>
                  </TableCell>
                  <TableCell
                    className={`text-xs ${
                      item.status === "submitted"
                        ? "text-foreground"
                        : "text-destructive"
                    }`}
                  >
                    {resultText}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
