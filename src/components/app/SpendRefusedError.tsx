"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/billing/InsufficientCreditsError.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import type { ApiError } from "@/shared/query/fetchJson";
import { spendRefusedView, type SpendRefusalCode } from "@/shared/query/errors";
import { ErrorState } from "@/components/app/ErrorState";
import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import { Button } from "@/components/ui/button";

/**
 * A spend refusal (feature off, daily or monthly cap, price changed) that says
 * why and, for the caps, where to look. A retry can't fix it, so there is no
 * retry button.
 *
 * The card's title always comes from the refusal itself. `title` is accepted so
 * callers can pass the same props as `QueryError`, but it never replaces it.
 */
export function SpendRefusedError({
  error,
  variant,
}: {
  error: ApiError & { code: SpendRefusalCode };
  variant?: "inline" | "card" | "page";
  title?: string;
}) {
  const view = spendRefusedView(error);
  const features = useWorkspace()?.features;
  const showUsageLink = view.showUsageLink && features?.usage_page === true;
  return (
    <ErrorState
      variant={variant}
      title={view.title}
      // `inline` shows no title, so the title leads the message there.
      message={variant === "inline" ? `${view.title}. ${view.text}` : view.text}
      action={showUsageLink ? <UsageButton /> : undefined}
    />
  );
}

function UsageButton() {
  return (
    // Its own text color: a red error around it would otherwise tint it.
    <Button
      variant="outline"
      size="sm"
      className="text-foreground"
      nativeButton={false}
      render={<Link href="/portal/usage" />}
    >
      View usage
    </Button>
  );
}
