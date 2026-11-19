"use client";

// F18 phase 4 — the AI access tab: what robots.txt lets each AI crawler fetch,
// plus the llms.txt check.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CardShell } from "@/components/app/CardShell";
import { InlineAlert } from "@/components/app/InlineAlert";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { hostOf } from "../shared";
import type { AiAccessRow, AuditSummary } from "../hooks/useAuditSummary";

type PurposeFilter = "all" | "search" | "assistant" | "training";

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info";

function accessMeta(row: AiAccessRow): { label: string; variant: BadgeVariant } {
  if (row.unknown) return { label: "Unverified", variant: "outline" };
  switch (row.status) {
    case "open":
      return { label: "Allowed", variant: "success" };
    case "partial":
      return { label: "Allowed here, restricted elsewhere", variant: "warning" };
    case "blocked":
      return { label: "Blocked", variant: "destructive" };
    default:
      return { label: "Unverified", variant: "outline" };
  }
}

function purposeMatches(row: AiAccessRow, filter: PurposeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "assistant") return row.purpose === "agent";
  return row.purpose === filter;
}

function purposeLabel(purpose: string): string {
  if (purpose === "agent") return "Assistant";
  if (purpose === "training") return "Training";
  return "Search";
}

export function AiAccessView({ summary }: { summary: AuditSummary }) {
  const [purpose, setPurpose] = useState<PurposeFilter>("all");
  const rows = summary.aiAccess.rows;
  const host = hostOf(summary.audit.startUrl);
  const searchRows = rows.filter((row) => row.purpose === "search");
  const searchAllowed = searchRows.filter(
    (row) => row.status === "open" && !row.unknown,
  ).length;
  const visible = rows.filter((row) => purposeMatches(row, purpose));
  const robotsStatus = summary.aiAccess.robotsStatus;
  const llms = summary.llmsTxt;

  return (
    <div className="space-y-3">
      <CardShell
        title="AI crawler access"
        action={
          <span className="text-xs text-muted-foreground">{host}</span>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {`What your robots.txt lets each AI crawler fetch on ${host}. Allowed doesn't mean a crawler visits or cites you.`}
          </p>

          {robotsStatus === "found" ? (
            <p className="text-sm">robots.txt found.</p>
          ) : robotsStatus === "missing" ? (
            <p className="text-sm">
              No robots.txt, so every crawler is allowed.
            </p>
          ) : (
            // No retry: robots.txt was read once, during the audit. Reloading
            // the stored summary would not read it again, so a Retry here
            // would promise a re-check that never happens.
            <InlineAlert
              tone="warning"
              title="We couldn't read robots.txt, so these results are unverified."
            />
          )}

          <p className="text-sm font-medium">
            {`${searchAllowed} of ${searchRows.length} AI search crawlers can read your homepage.`}
          </p>

          <SegmentedToggle<PurposeFilter>
            value={purpose}
            onChange={setPurpose}
            showLabels
            items={[
              { value: "all", label: "All", icon: null },
              { value: "search", label: "Search", icon: null },
              { value: "assistant", label: "Assistants", icon: null },
              { value: "training", label: "Training", icon: null },
            ]}
          />

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Crawler</TableHead>
                  <TableHead>Operator</TableHead>
                  <TableHead>Used for</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Rule</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const meta = accessMeta(row);
                  return (
                    <TableRow key={row.name}>
                      <TableCell className="font-mono text-xs">
                        {row.name}
                      </TableCell>
                      <TableCell>{row.operator ?? "—"}</TableCell>
                      <TableCell>{row.platform ?? "—"}</TableCell>
                      <TableCell>{purposeLabel(row.purpose)}</TableCell>
                      <TableCell>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell>
                        {row.matchedGroup ? (
                          <Tooltip>
                            <TooltipTrigger
                              delay={150}
                              render={<span className="cursor-help" />}
                            >
                              {row.matchedGroup}
                            </TooltipTrigger>
                            <TooltipContent>
                              {row.reason ?? "No rule matched."}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardShell>

      <CardShell title="llms.txt">
        {llms.status === "present" ? (
          <p className="text-sm">
            {`Found at /llms.txt: “${llms.firstLine ?? ""}”`}
          </p>
        ) : llms.status === "missing" ? (
          <p className="text-sm">
            No /llms.txt. It's optional; no answer engine is known to require
            it.
          </p>
        ) : llms.status === "invalid" ? (
          <Alert variant="warning">
            <AlertDescription>
              {`/llms.txt is served as ${llms.contentType ?? "an unknown type"} or has no # title line, so tools may ignore it.`}
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm">We couldn't check /llms.txt.</p>
        )}
      </CardShell>
    </div>
  );
}
