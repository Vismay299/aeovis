"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/FormDialog.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * A small settings-style dialog: title, labelled rows, right-aligned actions.
 * Render it only while it is open. Escape, the close button and a backdrop
 * click call `onClose`, except while `pending`, so a save in flight keeps its
 * dialog (and somewhere to show its error).
 */
export function FormDialog({
  title,
  onClose,
  actions,
  pending = false,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Set while the submit is in flight; blocks closing, like ConfirmDialog. */
  pending?: boolean;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
