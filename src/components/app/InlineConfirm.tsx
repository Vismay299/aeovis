"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/InlineConfirm.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import HoldButton from "@/components/kokonutui/hold-button";

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
  // Each step unmounts the button that was just used, which would drop
  // keyboard focus to the page (or, inside a popover, to the popup, which can
  // steal it back mid-hold). Focus moves to the button that replaced it.
  const [returnFocus, setReturnFocus] = useState(false);
  const leave = () => {
    setConfirming(false);
    setReturnFocus(true);
  };
  const size = triggerLabel ? "sm" : "xs";

  if (confirming) {
    return (
      <>
        {/* The final confirm is held, not clicked (1200 ms). The two-step
            shape and the Cancel path are unchanged. */}
        <HoldButton
          autoFocus
          variant="destructive"
          holdDuration={1200}
          holdingLabel="Keep holding"
          completeLabel={confirmLabel}
          disabled={pending || disabled}
          className={size === "sm" ? "h-8 min-w-0 px-3 text-xs" : "h-7 min-w-0 px-2.5 text-xs"}
          onHoldComplete={() => {
            leave();
            onConfirm();
          }}
        >
          {confirmLabel}
        </HoldButton>
        <Button
          variant="ghost"
          size={size}
          onClick={leave}
        >
          Cancel
        </Button>
      </>
    );
  }

  if (triggerLabel) {
    return (
      <Button
        autoFocus={returnFocus}
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
      autoFocus={returnFocus}
      disabled={pending || disabled}
      onClick={() => setConfirming(true)}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}
