"use client";

import { Sparkles } from "lucide-react";

/**
 * A loaded skill: a small card naming the workflow and its version. The skill
 * body itself never renders — it is instructions for the model, not the user.
 */
export function SkillResult({ name, title, version }: { name: string; title?: string; version?: string }) {
  return (
    <p className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      <span>
        Using skill: {title || name}
        {version ? ` · v${version}` : ""}
      </span>
    </p>
  );
}
