// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/integrations/GoogleAccountRemovalDialog.tsx:78-134
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Ga4LinkedAccount } from "./hooks/useGa4Accounts";

function impactCopy(n: number) {
  if (n === 0) return "No workspaces will be affected.";
  return `This will also disconnect Google Analytics from ${n} workspace${n === 1 ? "" : "s"}.`;
}

/**
 * Confirms removing a linked Google account. The impact comes from the
 * accounts list (`workspaces`), which is refetched while the dialog is open.
 */
export function GoogleAccountRemovalDialog({ account, impact, onClose, onConfirm, removing, error }: {
  account: Ga4LinkedAccount;
  impact: { loading: boolean; failed: boolean; workspaces: number | null; retry: () => void };
  onClose: () => void;
  onConfirm: () => void;
  removing: boolean;
  error: string | null;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !removing) onClose(); }}>
      <DialogContent fullScreenOnMobile>
        <DialogHeader>
          <DialogTitle>Remove Google account?</DialogTitle>
          <DialogDescription>
            This removes the account's Google Analytics connection from Perceev. You can reconnect it anytime.
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm font-medium">{account.email ?? `Google account · ${account.grantId.slice(-6)}`}</p>
        {impact.loading ? (
          <p className="text-sm text-muted-foreground">Checking connected workspaces…</p>
        ) : impact.failed || impact.workspaces === null ? (
          <p className="text-sm text-destructive">
            Couldn't check connected workspaces.{" "}
            <button type="button" className="underline" onClick={impact.retry}>Try again</button>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{impactCopy(impact.workspaces)}</p>
        )}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={removing}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} pending={removing} disabled={removing || impact.loading}>
            {removing ? "Removing…" : "Remove account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
