"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { fetchJson, isApiError, withBrand } from "@/lib/query/fetchJson";
import { describeError } from "@/lib/query/errors";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { useJobStatus } from "@/components/app/hooks/useJobStatus";
import type { PriceQuote } from "@/shared/pricing";
import type { SavedKeywordRow } from "@/shared/keywords";

type ProposalCluster = {
  name: string;
  intent: string;
  priority: string;
  targetPage: string | null;
  rationale: string;
  savedKeywordIds: string[];
};

type ProposalResult = {
  clusters: ProposalCluster[];
  unsorted: string[];
  model: string;
  usd: number | null;
};

const DETAIL =
  "One AI call groups the selected keywords into page-level topics. Nothing is tagged until you apply it.";

export function GroupTopicsDialog({
  open,
  onOpenChange,
  brandKey,
  selectedRows,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  brandKey: string;
  selectedRows: SavedKeywordRow[];
  onApplied?: () => void;
}) {
  const queryClient = useQueryClient();
  const ids = selectedRows.map((r) => r.id);
  const keywordsById = new Map(selectedRows.map((r) => [r.id, r.keyword]));
  const quote = usePriceQuote(
    { brandKey, action: "keywords.clustering.run", input: { savedKeywordIds: ids } },
    { enabled: open && ids.length >= 10 },
  );

  const [costOpen, setCostOpen] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalResult | null>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [applying, setApplying] = useState(false);

  const job = useJobStatus(brandKey, jobId);

  useEffect(() => {
    if (!open) {
      setCostOpen(true);
      setJobId(null);
      setPriceChanged(null);
      setPending(false);
      setError(null);
      setProposal(null);
      setChecked({});
      setNames({});
      setExpanded({});
      setApplying(false);
    }
  }, [open ]);

  useEffect(() => {
    if (job.data?.status === "completed" && !proposal) {
      const res = (job.data.result ?? {}) as ProposalResult;
      const clusters = res.clusters ?? [];
      setProposal({ ...res, clusters, unsorted: res.unsorted ?? [] });
      const initChecked: Record<number, boolean> = {};
      const initNames: Record<number, string> = {};
      clusters.forEach((c, i) => {
        initChecked[i] = true;
        initNames[i] = c.name;
      });
      setChecked(initChecked);
      setNames(initNames);
    }
    if (job.data?.status === "failed" && !proposal) {
      setError(job.data.error?.message ?? "Something went wrong. Please try again.");
    }
  }, [job.data, proposal]);

  const closeAll = () => onOpenChange(false);

  const runCluster = async (maxUsd: number) => {
    setPending(true);
    setError(null);
    try {
      const res = await fetchJson<{ jobId: string; status: string; pollAfterSeconds: number }>(
        withBrand("/api/customer/keywords/cluster", brandKey),
        { method: "POST", body: { savedKeywordIds: ids, maxUsd } },
      );
      setJobId(res.jobId);
      setCostOpen(false);
    } catch (caught) {
      if (isApiError(caught) && caught.code === "price_changed") {
        const details = caught.details as
          | { approvedMaxUsd?: number; quote?: PriceQuote }
          | undefined;
        if (details?.quote) {
          setPriceChanged({ approvedMaxUsd: Number(details.approvedMaxUsd ?? maxUsd), quote: details.quote });
        }
      } else if (isApiError(caught) && caught.code === "job_already_running") {
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? describeError(caught) : "Something went wrong. Please try again.");
      }
    } finally {
      setPending(false);
    }
  };

  const selectedCount = proposal?.clusters.filter((_, i) => checked[i]).length ?? 0;
  const taggedKeywordCount =
    proposal?.clusters
      .filter((_, i) => checked[i])
      .reduce((sum, c) => sum + c.savedKeywordIds.length, 0) ?? 0;

  const apply = async () => {
    if (!jobId || !proposal) return;
    const appliedClusters = proposal.clusters
      .map((c, i) =>
        checked[i]
          ? { name: (names[i] ?? c.name).trim() || c.name, savedKeywordIds: c.savedKeywordIds }
          : null,
      )
      .filter((c) => c !== null);
    if (appliedClusters.length === 0) {
      closeAll();
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const res = await fetchJson<{ taggedCount: number; tags: unknown[] }>(
        withBrand("/api/customer/keywords/cluster/apply", brandKey),
        { method: "POST", body: { jobId, clusters: appliedClusters } },
      );
      toast.success(`Tagged ${res.taggedCount} keywords in ${appliedClusters.length} topics`);
      closeAll();
      onApplied?.();
      void queryClient.invalidateQueries({ queryKey: ["savedKeywords", brandKey] });
    } catch (caught) {
      setError(caught instanceof Error ? describeError(caught) : "Something went wrong. Please try again.");
    } finally {
      setApplying(false);
    }
  };

  const running =
    jobId !== null && (!job.data || job.data.status === "queued" || job.data.status === "running");
  const failed = jobId !== null && job.data?.status === "failed" && !proposal;
  const done = proposal !== null;

  return (
    <>
      <CostReviewDialog
        open={open && costOpen && !jobId}
        title="Group into topics"
        confirmLabel="Group keywords"
        pendingLabel="Starting…"
        quote={quote}
        pending={pending}
        priceChanged={priceChanged}
        error={error}
        onConfirm={(maxUsd) => void runCluster(maxUsd)}
        onClose={closeAll}
        detail={() => <span>{DETAIL}</span>}
      />

      <Dialog open={open && (running || failed || done)} onOpenChange={(v) => { if (!v) closeAll(); }}>
        <DialogContent fullScreenOnMobile className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Group into topics</DialogTitle>
          </DialogHeader>

          {running ? (
            <div className="flex items-center gap-2 py-6" aria-live="polite">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>Grouping {ids.length} keywords into topics…</span>
            </div>
          ) : null}

          {failed ? (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertDescription>
                  Grouping failed. You were charged only for the AI call that ran.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={closeAll}>
                  Close
                </Button>
              </DialogFooter>
            </div>
          ) : null}

          {done && proposal ? (
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {proposal.clusters.map((c, i) => {
                const count = c.savedKeywordIds.length;
                const isOpen = expanded[i] ?? false;
                return (
                  <div key={i} className="space-y-2 rounded border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Checkbox
                        checked={checked[i] ?? true}
                        onCheckedChange={(v: boolean | "indeterminate") =>
                          setChecked((prev) => ({ ...prev, [i]: v === true }))
                        }
                        aria-label={`Include ${c.name}`}
                      />
                      <Input
                        value={names[i] ?? c.name}
                        onChange={(e) => setNames((prev) => ({ ...prev, [i]: e.target.value }))}
                        aria-label="Topic name"
                        className="max-w-xs"
                      />
                      <Badge variant="secondary">{c.intent}</Badge>
                      <Badge variant="outline">{c.priority}</Badge>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline hover:no-underline"
                        onClick={() => setExpanded((prev) => ({ ...prev, [i]: !isOpen }))}
                        aria-expanded={isOpen}
                      >
                        {count} keywords
                      </button>
                    </div>
                    {isOpen ? (
                      <ul className="list-disc space-y-1 pl-6 text-sm">
                        {c.savedKeywordIds.map((id) => (
                          <li key={id}>{keywordsById.get(id) ?? id}</li>
                        ))}
                      </ul>
                    ) : null}
                    {c.targetPage ? (
                      <a href={c.targetPage} className="block truncate text-xs text-blue-600" target="_blank" rel="noreferrer">
                        {c.targetPage}
                      </a>
                    ) : (
                      <span className="block text-xs text-muted-foreground">New page</span>
                    )}
                  </div>
                );
              })}
              {proposal.unsorted.length > 0 ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={false} disabled aria-label="Include Unsorted" />
                  <span>Unsorted ({proposal.unsorted.length})</span>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">Tags are added. Existing tags stay.</p>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <Button variant="outline" onClick={closeAll}>
                  Cancel
                </Button>
                <Button onClick={() => void apply()} disabled={applying || selectedCount === 0}>
                  {applying ? "Applying…" : `Apply tags to ${selectedCount} topics`}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
