"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/layout/AppBanner.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** The full-width notice strip above the page content in the app shell. */
export function AppBanner({
  variant,
  icon,
  children,
}: {
  variant: "info" | "warning" | "destructive";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Alert variant={variant} banner className="shrink-0">
      {icon}
      <AlertDescription className="text-foreground">
        {children}
      </AlertDescription>
    </Alert>
  );
}
