"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/prompt-explorer.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { Suspense } from "react";
import { ExplorePage } from "@/components/portal/explore/ExplorePage";
import { ExploreLoadingState } from "@/components/portal/explore/ExploreLoadingState";

export default function PromptExplorerPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6">
          <ExploreLoadingState models={["chatgpt", "gemini", "perplexity"]} />
        </div>
      }
    >
      <ExplorePage />
    </Suspense>
  );
}
