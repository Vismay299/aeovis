// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/reports/shared.tsx:84-108
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { ConfirmDialog } from "@/components/app/ConfirmDialog";

// The report delete confirm. Reports have no version history and no undo; a
// revoked public link stops working, which the body says outright.
export function DeleteReportDialog({
  title,
  isPending,
  onClose,
  onConfirm,
}: {
  title: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Delete \u201c${title}\u201d?`}
      confirmLabel="Delete report"
      destructive
      pending={isPending}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      This cannot be undone. A public link stops working.
    </ConfirmDialog>
  );
}
