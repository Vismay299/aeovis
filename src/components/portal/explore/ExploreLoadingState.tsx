"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/components/PromptExplorerLoadingState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { Skeleton } from "@/components/ui/skeleton";
import { type ExploreModel, exploreModelLabel } from "@/shared/explore";
import { ENGINE_ACCENTS } from "./engineAccents";
import { cn } from "@/lib/utils";

export function ExploreLoadingCard({ model }: { model: ExploreModel }) {
  const accent = ENGINE_ACCENTS[model] ?? {
    borderClass: "border-l-border",
    dotClass: "bg-muted-foreground",
  };
  const label = exploreModelLabel(model);

  return (
    <article
      aria-busy="true"
      className={cn(
        "rounded-xl border border-border bg-card p-5 shadow-sm border-l-4 space-y-4",
        accent.borderClass,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <span className={cn("size-2.5 rounded-full shrink-0", accent.dotClass)} />
          <h3 className="font-semibold text-base tracking-tight">{label}</h3>
          <span className="text-xs text-muted-foreground italic">Asking model…</span>
        </div>
        <Skeleton className="h-5 w-20" />
      </header>

      <div className="space-y-2.5 pt-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>

      <div className="pt-2 border-t border-border/40 flex items-center justify-between">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3.5 w-24" />
      </div>
    </article>
  );
}

export function ExploreLoadingState({ models }: { models: readonly ExploreModel[] }) {
  return (
    <div className="space-y-4">
      <div aria-live="polite" className="text-sm text-muted-foreground">
        Asking {models.length} {models.length === 1 ? "model" : "models"}… This usually takes under a minute.
      </div>
      <div className="grid gap-4">
        {models.map((model) => (
          <ExploreLoadingCard key={model} model={model} />
        ))}
      </div>
    </div>
  );
}
