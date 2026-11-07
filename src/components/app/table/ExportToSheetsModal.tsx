"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/table/ExportToSheetsModal.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  closeSheetsModal,
  getSheetsModalState,
  subscribeSheetsModal,
} from "@/lib/export/sheetsModalStore";
import { GOOGLE_SHEETS_NEW_URL } from "@/lib/export/clipboard";

export function ExportToSheetsModal() {
  const state = useSyncExternalStore(
    subscribeSheetsModal,
    getSheetsModalState,
    getSheetsModalState,
  );

  const pathname = usePathname();
  const lastPathnameRef = useRef(pathname);

  // Close modal when navigating away mid-flow
  useEffect(() => {
    if (lastPathnameRef.current !== pathname) {
      lastPathnameRef.current = pathname;
      closeSheetsModal();
    }
  }, [pathname]);

  if (!state.isOpen) return null;

  const { rowCount } = state;

  const handleOpenSheet = () => {
    window.open(GOOGLE_SHEETS_NEW_URL, "_blank", "noopener,noreferrer");
    closeSheetsModal();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeSheetsModal();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8 leading-snug">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
              <Check className="size-4" />
            </span>
            Copied {rowCount} row{rowCount === 1 ? "" : "s"} to your clipboard
          </DialogTitle>
          <DialogDescription>
            Open a new Google Sheet and paste to fill it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleOpenSheet}>
            Open new Google Sheet
            <ExternalLink data-icon="inline-end" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
