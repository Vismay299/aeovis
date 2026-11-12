// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchEmptyState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Globe } from "lucide-react";
import { EmptyState } from "@/components/app/EmptyState";

export function KeywordResearchEmptyState({ title = "Enter a keyword to get started", description = "Search for any keyword to see volume, difficulty, CPC, and related keyword ideas." }: { title?: string; description?: string }) {
  return <EmptyState icon={Globe} title={title} description={description} />;
}
