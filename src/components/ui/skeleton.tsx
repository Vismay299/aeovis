"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/ui/skeleton.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { cn } from "@/shared/utils";

// bg-muted is the page background in the light theme, so a muted skeleton
// would not show outside a card. A foreground tint shows on both surfaces.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("skeleton-shimmer rounded-md bg-foreground/10", className)}
      {...props}
    />
  );
}

export { Skeleton };
