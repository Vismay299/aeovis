"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/ConfirmDialog.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import HoldButton from "@/components/kokonutui/hold-button";

/**
 * Asks before an action that cannot be undone: a delete, or one that spends
 * credits. Render it only while it is open. `onConfirm` does not close it, so
 * the caller closes it right away or when the mutation settles. While
 * `pending`, Cancel and Escape do nothing.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onClose,
  pending = false,
  destructive = false,
  children,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="confirm-dialog-cancel" disabled={pending}>Cancel</AlertDialogCancel>
          {/* A destructive confirm cannot be finished with one click: it is
              held for 1200 ms (space/enter works too). The dialog, its copy and
              the cancel path are unchanged. Spending confirmations keep the
              normal button; their slider lives in PricedActionButton. */}
          {destructive ? (
            <HoldButton
              data-testid="confirm-dialog-hold"
              variant="destructive"
              holdDuration={1200}
              holdingLabel="Keep holding"
              completeLabel={confirmLabel}
              disabled={pending}
              onHoldComplete={onConfirm}
            >
              {confirmLabel}
            </HoldButton>
          ) : (
            <Button variant="default" pending={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
