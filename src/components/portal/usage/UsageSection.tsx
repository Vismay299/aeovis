"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/billing/BillingUsageSection.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";

/**
 * One titled block inside the spend card. The right-hand text is the caller's
 * (the range label), so the section never guesses which window it shows.
 */
export function UsageSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {action ? (
          <span className="text-sm text-muted-foreground">{action}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}
