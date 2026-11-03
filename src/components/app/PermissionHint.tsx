"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/PermissionHint.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { cn } from "@/lib/utils";

/** Shown where a missing permission would otherwise leave a card or step empty. */
export function PermissionHint({
  action,
  className,
}: {
  action: string;
  className?: string;
}) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      Ask a workspace owner to {action}.
    </p>
  );
}
