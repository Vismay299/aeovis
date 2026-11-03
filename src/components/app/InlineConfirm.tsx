"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/InlineConfirm.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Two-step delete for a list row: the trash icon swaps to an explicit
 * Remove/Cancel pair, so a stray click can't destroy anything and no dialog
 * is needed. With `triggerLabel`, the trash icon becomes a text button.
 */
export function InlineConfirm({
  label,
  triggerLabel,
  confirmLabel = "Remove",
  pending,
  disabled = false,
  onConfirm,
}: {
  /** Accessible name of the trash button, for example "Remove example.com". */
  label: string;
  /** Show a text button, such as "Archive workspace", instead of the trash icon. */
  triggerLabel?: string;
  confirmLabel?: string;
  pending: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const size = triggerLabel ? "sm" : "xs";

  if (confirming) {
    return (
      <>
        <Button
          variant="destructive"
          size={size}
          disabled={pending || disabled}
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button
          variant="ghost"
          size={size}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </>
    );
  }

  if (triggerLabel) {
    return (
      <Button
        variant="destructive"
        size={size}
        disabled={pending || disabled}
        onClick={() => setConfirming(true)}
      >
        {triggerLabel}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-destructive hover:text-destructive"
      aria-label={label}
      disabled={pending || disabled}
      onClick={() => setConfirming(true)}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}
