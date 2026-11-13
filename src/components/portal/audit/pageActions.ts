// F18 phase 4 — the audit page-action registry (types fixed by F19 §6.6.3).
//
// F18 ships none of its own. F19 appends the IndexNow action here in its own
// PR, so the pages table's bulk bar and row menu can run it without either
// feature editing the other.

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

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

export const AUDIT_PAGE_ACTIONS: AuditPageAction[] = [];
