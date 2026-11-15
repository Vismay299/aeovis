// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/platformLabels.ts:13-35
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ExploreModel } from "@/shared/explore";

export type EngineAccent = {
  borderClass: string;
  dotClass: string;
  badgeClass: string;
};

export const ENGINE_ACCENTS: Record<ExploreModel, EngineAccent> = {
  chatgpt: {
    borderClass: "border-l-emerald-500",
    dotClass: "bg-emerald-500",
    badgeClass: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  },
  gemini: {
    borderClass: "border-l-sky-500",
    dotClass: "bg-sky-500",
    badgeClass: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
  },
  perplexity: {
    borderClass: "border-l-violet-500",
    dotClass: "bg-violet-500",
    badgeClass: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
  },
};
