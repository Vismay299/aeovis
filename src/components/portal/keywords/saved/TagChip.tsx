// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { cn } from "@/shared/utils";
import { resolveTagColor, tagChipClass } from "@/shared/tag-colors";

/** One saved-keyword tag, in its stable palette colour. */
export function TagChip({
  tag,
  className,
}: {
  tag: { id: string; name: string; color?: string | null };
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-xs font-medium",
        tagChipClass(resolveTagColor(tag)),
        className,
      )}
    >
      {tag.name}
    </span>
  );
}
