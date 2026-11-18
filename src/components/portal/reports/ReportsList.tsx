// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/reports/ReportsList.tsx:20-99
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Globe, Sparkles, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/app/EmptyState";
import { RowActionsMenu } from "@/components/app/RowActionsMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTimestamp, relativeTime } from "@/shared/format";
import { REPORT_APP_LIST_LIMIT } from "@/shared/reports";
import { formatWrittenBy } from "./formatWrittenBy.ts";
import type { ReportListItem } from "./hooks/useReports.ts";

function UpdatedCell({ value }: { value: string }) {
  return (
    <span
      className="whitespace-nowrap text-muted-foreground"
      title={formatTimestamp(value)}
    >
      {relativeTime(value)}
    </span>
  );
}

export function ReportsList({
  reports,
  canGenerate,
  canOpenAssistant,
  onDelete,
  onGenerate,
}: {
  reports: ReportListItem[];
  canGenerate: boolean;
  canOpenAssistant: boolean;
  onDelete: (report: ReportListItem) => void;
  onGenerate: () => void;
}) {
  const router = useRouter();

  if (reports.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No reports yet"
        description="Ask the assistant for a report, or generate one from a template."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {canOpenAssistant ? (
              <Button
                variant="secondary"
                onClick={() => router.push("/portal/assistant")}
              >
                Open assistant
              </Button>
            ) : null}
            {canGenerate ? (
              <Button onClick={onGenerate}>
                <Sparkles data-icon="inline-start" />
                Generate report
              </Button>
            ) : null}
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Written by</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Sharing</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {reports.map((report) => (
              <TableRow key={report.id}>
                <TableCell className="max-w-[420px]">
                  <Link
                    href={`/portal/reports/${report.id}`}
                    className="font-medium hover:underline"
                  >
                    {report.title}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatWrittenBy(report)}
                </TableCell>
                {/* The template the report was written from, else the skill
                    that produced it: what a reader needs to tell two reports
                    on the same site apart. */}
                <TableCell className="text-muted-foreground">
                  {report.templateName ?? report.skillTitle ?? "\u2014"}
                </TableCell>
                <TableCell>
                  {report.shared ? (
                    <Badge variant="secondary">
                      <Globe data-icon="inline-start" />
                      Public
                    </Badge>
                  ) : (
                    <Badge variant="outline">Private</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <UpdatedCell value={report.updatedAt} />
                </TableCell>
                <TableCell className="w-10 text-right">
                  <RowActionsMenu label={`Actions for ${report.title}`}>
                    <DropdownMenuItem
                      onClick={() => router.push(`/portal/reports/${report.id}`)}
                    >
                      Open
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDelete(report)}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </RowActionsMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>
      {reports.length === REPORT_APP_LIST_LIMIT ? (
        <p className="text-xs text-muted-foreground">
          Showing the {REPORT_APP_LIST_LIMIT} most recent reports.
        </p>
      ) : null}
    </div>
  );
}
