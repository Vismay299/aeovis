// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/reports/ReportTemplatesList.tsx:17-86
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { LayoutTemplate, Pencil, Sparkles, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/app/EmptyState";
import { RowActionsMenu } from "@/components/app/RowActionsMenu";
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
import type { ReportTemplateItem } from "./hooks/useReports.ts";

export function ReportTemplatesList({
  templates,
  canGenerate,
  onEdit,
  onDelete,
  onGenerate,
}: {
  templates: ReportTemplateItem[];
  canGenerate: boolean;
  onEdit: (template: ReportTemplateItem) => void;
  onDelete: (template: ReportTemplateItem) => void;
  onGenerate: (template: ReportTemplateItem) => void;
}) {
  if (templates.length === 0) {
    return (
      <EmptyState
        icon={LayoutTemplate}
        title="No templates yet"
        description="A template is a reusable brief for a kind of report: who it is for, which sections it has, how it sounds."
      />
    );
  }

  return (
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((template) => (
            <TableRow key={template.id}>
              <TableCell>
                <button
                  type="button"
                  className="cursor-pointer text-left font-medium hover:underline"
                  onClick={() => onEdit(template)}
                >
                  {template.name}
                </button>
              </TableCell>
              <TableCell className="max-w-[420px] text-muted-foreground">
                {template.description}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                <span title={formatTimestamp(template.updatedAt)}>
                  {relativeTime(template.updatedAt)}
                </span>
              </TableCell>
              <TableCell className="w-10 text-right">
                <RowActionsMenu label={`Actions for ${template.name}`}>
                  {canGenerate ? (
                    <DropdownMenuItem onClick={() => onGenerate(template)}>
                      <Sparkles />
                      Generate report
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={() => onEdit(template)}>
                    <Pencil />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onDelete(template)}
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
  );
}
