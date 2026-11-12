// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/components/IntentBadge.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Badge } from "@/components/ui/badge";

export function IntentBadge({ intent }: { intent: string | null | undefined }) {
  if (!intent) return <span aria-label="Unknown intent">—</span>;
  return <Badge variant="outline" className="capitalize">{intent.replaceAll("_", " ")}</Badge>;
}
