// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/audit/issues/$resultId.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { LighthouseIssuesScreen } from "@/components/portal/audit/lighthouse/LighthouseIssuesScreen";
import type { CategoryTab } from "@/components/portal/audit/lighthouse/types";

const VALID: CategoryTab[] = ["all", "performance", "accessibility", "best-practices", "seo"];

export default function SiteAuditLighthouseRoute() {
  const params = useParams<{ auditId: string; resultId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const raw = search.get("category") as CategoryTab | null;
  const category: CategoryTab = raw && (VALID as string[]).includes(raw) ? raw : "all";
  return (
    <LighthouseIssuesScreen
      auditId={params.auditId}
      resultId={params.resultId}
      category={category}
      onCategoryChange={(next) => router.replace(`?category=${next}`)}
    />
  );
}
