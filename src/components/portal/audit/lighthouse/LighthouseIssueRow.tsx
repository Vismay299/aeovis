// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/lighthouse/issues/LighthouseIssueRow.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import type { LighthouseIssue } from "./types.ts";

function impactText(issue: LighthouseIssue): string | null {
  if (issue.impactMs != null) return `${issue.impactMs} ms`;
  if (issue.impactBytes != null) return `${Math.round(issue.impactBytes / 1024)} KiB`;
  return null;
}

export function LighthouseIssueRow({ issue }: { issue: LighthouseIssue }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell className="w-8">
          <button type="button" aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen((v) => !v)}>
            {open ? "−" : "+"}
          </button>
        </TableCell>
        <TableCell className="w-24">
          <Badge variant={issue.severity === "critical" ? "destructive" : issue.severity === "warning" ? "outline" : "secondary"}>
            {issue.severity}
          </Badge>
        </TableCell>
        <TableCell>
          <span className="font-medium">{issue.title}</span>
          {issue.displayValue ? <span className="ml-2 text-sm text-muted-foreground">{issue.displayValue}</span> : null}
        </TableCell>
        <TableCell className="hidden w-28 sm:table-cell">{issue.category}</TableCell>
        <TableCell className="hidden w-28 md:table-cell text-right">{impactText(issue) ?? "—"}</TableCell>
        <TableCell className="w-14 text-right">{issue.score ?? "—"}</TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={6}>
            <p className="text-sm text-muted-foreground">{issue.description}</p>
            {issue.items.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {issue.items.slice(0, 10).map((item, i) => (
                  <li key={i} className="break-all">
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
