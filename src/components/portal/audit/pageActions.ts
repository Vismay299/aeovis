// F18 phase 4 — the audit page-action registry (types fixed by F19 §6.6.3).
//
// F18 ships none of its own. F19 appends the IndexNow action here in its own
// PR, so the pages table's bulk bar and row menu can run it without either
// feature editing the other.

import { lazy, type ComponentType } from "react";
import { Send, type LucideIcon } from "lucide-react";

export type AuditPageRef = {
  url: string;
  statusCode: number | null;
  indexable: boolean | null;
};

export type AuditPageAction = {
  id: string;
  label: string;
  flag?: string;
  icon?: LucideIcon;
  eligible(page: AuditPageRef): boolean;
  Dialog: ComponentType<{
    brandKey: string;
    auditId: string;
    pages: AuditPageRef[];
    onClose(): void;
  }>;
};

const SubmitIndexNowDialogComponent = lazy(
  () => import("../indexnow/SubmitIndexNowDialog.tsx"),
) as unknown as ComponentType<{
  brandKey: string;
  auditId: string;
  pages: AuditPageRef[];
  onClose(): void;
}>;

export const AUDIT_PAGE_ACTIONS: AuditPageAction[] = [
  {
    id: "indexnow_submit",
    label: "Submit to IndexNow",
    flag: "indexnow",
    icon: Send,
    eligible: (page) =>
      page.statusCode !== null &&
      page.statusCode >= 200 &&
      page.statusCode < 300 &&
      page.indexable !== false,
    Dialog: SubmitIndexNowDialogComponent,
  },
];
