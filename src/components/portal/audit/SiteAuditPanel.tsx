"use client";

// F18 phase 4 — the audit tab's panel: the launch screen without an audit id,
// the audit detail with one.

import { AuditDetail } from "./AuditDetail";
import { LaunchView } from "./launch/LaunchView";

export default function SiteAuditPanel({
  brandKey,
  auditId,
}: {
  brandKey: string;
  auditId: string | null;
}) {
  if (auditId) return <AuditDetail brandKey={brandKey} auditId={auditId} />;
  return <LaunchView brandKey={brandKey} />;
}
