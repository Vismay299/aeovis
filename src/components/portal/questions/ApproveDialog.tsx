"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { ApiError } from "@/shared/query/fetchJson";
import { usePortal } from "@/components/portal/PortalShell";
import type { QuestionsState } from "./hooks/useQuestions";
import { useQuestionMutations, isRevisionConflict } from "./hooks/useQuestionMutations";

export function ApproveDialog({
  open,
  onOpenChange,
  state,
  brandKey,
  onConflict,
  onApproved,
  onOfferBaseline,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: QuestionsState;
  brandKey: string;
  onConflict: () => void;
  onApproved: () => void;
  onOfferBaseline: () => void;
}) {
  const { scan } = usePortal();
  const mutations = useQuestionMutations(brandKey);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextVersion = (state.approved?.version ?? 0) + 1;
  const active = useMemo(() => state.questions.filter((q) => q.status === "active"), [state.questions]);
  const byTopic = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of active) m.set(q.topic, (m.get(q.topic) || 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => (a === "General" ? 1 : b === "General" ? -1 : a.localeCompare(b)));
  }, [active]);
  const diagnosticCount = active.filter((q) => q.branded).length;
  // The recommendation/information split is decided server-side at approval
  // (no dry-run endpoint), so only the diagnostic count is known here.
  const nonDiagnosticCount = Math.max(0, active.length - diagnosticCount);
  const firstApproval = !state.approved;

  async function approve() {
    setConflict(false);
    setError(null);
    try {
      const res = await mutations.approve.mutateAsync({ expectedRevision: state.revision });
      const version = res?.panel?.version ?? nextVersion;
      toast.success(`Approved. Scans ask version ${version} from now on.`, {
        // A first approval opens the baseline cost dialog instead.
        action: !firstApproval && !scan?.active ? {
          label: "Run scan",
          onClick: () => scan?.start?.(),
        } : undefined,
      });
      onApproved();
      if (firstApproval) onOfferBaseline();
    } catch (e) {
      if (isRevisionConflict(e)) {
        setConflict(true);
        onConflict();
        return;
      }
      if (e instanceof ApiError) {
        if (e.code === "near_duplicates") {
          onOpenChange(false);
          // NearDuplicates alert is already shown in editor
          return;
        }
        if (e.code === "persona_required") {
          setError(e.message);
          // focus handled by UI if panel context open; minimal here
          return;
        }
      }
      setError((e as any)?.message || "Could not approve questions.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fullScreenOnMobile>
        <DialogHeader><DialogTitle>Approve version {nextVersion}?</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          {conflict ? (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>These questions changed since you opened them.</span>
                <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <div className="space-y-1 text-sm">
            {byTopic.map(([topic, count]) => <div key={topic}>{topic}: {count}</div>)}
          </div>
          <p className="text-sm text-muted-foreground">
            {nonDiagnosticCount} recommendation or information · {diagnosticCount} diagnostic
          </p>
          <p className="text-sm text-muted-foreground">
            Every scan from now on asks exactly these {active.length} questions. Earlier scans keep the version they asked.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={approve} disabled={mutations.approve.isPending}>Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
