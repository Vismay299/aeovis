// F18 phase 4 — the audit tab registry (types fixed by F19 §6.6.3).
//
// The panel is loaded with `lazy` so this module stays plain TypeScript: the
// registry test runs under `node --test`, which cannot evaluate a `.tsx` file,
// and the dynamic import is not executed until a panel actually renders.

import { lazy, type ComponentType } from "react";

const SiteAuditPanel = lazy(
  () => import("./SiteAuditPanel.tsx"),
) as unknown as ComponentType<{ brandKey: string; auditId: string | null }>;

export type AuditTab = {
  id: string;
  label: string;
  flag?: string;
  Panel: ComponentType<{ brandKey: string; auditId: string | null }>;
};

export const AUDIT_TABS: AuditTab[] = [
  { id: "audit", label: "Site audit", Panel: SiteAuditPanel },
];
