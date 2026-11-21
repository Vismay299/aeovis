"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/ErrorState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { EmptyState } from "@/components/app/EmptyState";
import { InlineAlert } from "@/components/app/InlineAlert";
import { Button } from "@/components/ui/button";

/**
 * A failure message with an optional retry.
 *
 * - `inline`: red text and a small button, inside a card or a table.
 * - `card`: the inline alert, above or in place of a section.
 * - `page`: a centered block that replaces the whole page content.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  isRetrying = false,
  action,
  variant = "card",
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  /** Shows the retry button as pending, for example while `isFetching`. */
  isRetrying?: boolean;
  /** Replaces the retry button, for errors a retry cannot fix. */
  action?: ReactNode;
  variant?: "inline" | "card" | "page";
}) {
  const button =
    action ??
    (onRetry ? (
      <Button
        variant="outline"
        size={variant === "page" ? "default" : "sm"}
        pending={isRetrying}
        onClick={onRetry}
      >
        Try again
      </Button>
    ) : null);

  if (variant === "page") {
    return (
      <EmptyState
        kind="error"
        variant="plain"
        size="lg"
        title={title ?? "Something went wrong"}
        description={message}
        action={button}
      />
    );
  }

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-destructive"
      >
        <span>{message}</span>
        {button}
      </div>
    );
  }

  // T8: the card is the locked inline alert. Its retry is the caller's real
  // refetch, pending while that request runs; the next render is the result.
  return (
    <InlineAlert
      tone="error"
      title={title ?? message}
      message={title ? message : undefined}
      onRetry={action ? undefined : onRetry}
      retrying={isRetrying}
      action={action}
    />
  );
}
