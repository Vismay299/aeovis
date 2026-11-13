// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/audit/index.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useParams } from "next/navigation";
import { AuditPage } from "@/components/portal/audit/AuditPage";

export default function SiteAuditDetailRoute() {
  const params = useParams<{ auditId: string }>();
  return <AuditPage auditId={params.auditId} />;
}
