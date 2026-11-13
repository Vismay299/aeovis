"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
// no lucide-react import (types unavailable in this toolchain)
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { useJobStatus } from "@/components/app/hooks/useJobStatus";
import type { SavedKeywordRow } from "@/shared/keywords";

type ProposalCluster = {
  name: string;
  intent: string;
  priority: string;
  targetPage: string | null;
  rationale: string;
  savedKeywordIds: string[];
};

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
  const quote = usePriceQuote(
    { brandKey, action: "keywords.clustering.run", input: { savedKeywordIds: ids } },
    { enabled: open && ids.length >= 10 },
  );

  const [costOpen, setCostOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState<{
    approvedMaxUsd: number;
    quote: any;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clusters, setClusters] = useState<ProposalCluster[]>([]);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const [unsorted, setUnsorted] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  const job = useJobStatus(brandKey, jobId);

  useEffect(() => {
    if (!open) {
      setJobId(null);
      setClusters([]);
      setChecked({});
      setNames({});
      setUnsorted([]);
      setError(null);
      setPending(false);
      setApplying(false);
      setPriceChanged(null);
    }
  }, [open]);

  useEffect(() => {
    if (job.data?.status === "completed" && clusters.length === 0) {
      const res = job.data.result as { clusters?: ProposalCluster[]; unsorted?: string[] };
      const c = res?.clusters ?? [];
      setClusters(c);
      const initChecked: Record<number, boolean> = {};
      const initNames: Record<number, string> = {};
      c.forEach((cl, i) => {
        initChecked[i] = true;
        initNames[i] = cl.name;
      });
      setChecked(initChecked);
      setNames(initNames);
      setUnsorted(res?.unsorted ?? []);
    }
    if (job.data?.status === "failed") {
      setError(job.data.error?.message ?? "Grouping failed.");
    }
  }, [job.data, clusters.length]);

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
    } catch (e: any) {
      if (e?.code === "price_changed") {
        setPriceChanged({ approvedMaxUsd: maxUsd, quote: quote.data });
        setCostOpen(true);
      } else {
        setError(e?.message ?? "Failed to start grouping.");
      }
    } finally {
      setPending(false);
    }
  };

  const apply = async () => {
    if (!jobId) return;
    const appliedClusters = clusters
      .map((c, i) => (checked[i] ? { name: names[i] || c.name, savedKeywordIds: c.savedKeywordIds } : null))
      .filter(Boolean) as { name: string; savedKeywordIds: string[] }[];
    if (appliedClusters.length === 0) {
      onOpenChange(false);
      return;
    }
    setApplying(true);
    try {
      const res = await fetchJson<{ taggedCount: number; tags: any[] }>(
        withBrand("/api/customer/keywords/cluster/apply", brandKey),
        { method: "POST", body: { jobId, clusters: appliedClusters } },
      );
      const topicCount = appliedClusters.length;
      toast.success(`Tagged ${res.taggedCount} keywords in ${topicCount} topics`);
      onOpenChange(false);
      onApplied?.();
      void queryClient.invalidateQueries({ queryKey: ["savedKeywords", brandKey] });
    } catch (e: any) {
      setError(e?.message ?? "Apply failed.");
    } finally {
      setApplying(false);
    }
  };

  const isRunning = jobId !== null && (job.data?.status === "queued" || job.data?.status === "running" || !job.data);
  const isCompleted = jobId !== null && job.data?.status === "completed" && clusters.length > 0;
  const isFailed = jobId !== null && job.data?.status === "failed";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Group into topics</DialogTitle>
          </DialogHeader>

          {!jobId && !costOpen ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                One AI call groups the selected keywords into page-level topics. Nothing is tagged until you apply it.
              </p>
              <Button onClick={() => setCostOpen(true)} disabled={pending || ids.length < 10}>
                {pending ? "Starting…" : "Group keywords"}
              </Button>
            </div>
          ) : null}

          {costOpen ? (
            <CostReviewDialog
              open={costOpen}
              title="Group into topics"
              confirmLabel="Group keywords"
              pendingLabel="Starting…"
              quote={quote}
              pending={pending}
              priceChanged={priceChanged}
              error={error}
              onConfirm={(maxUsd) => void runCluster(maxUsd)}
              onClose={() => setCostOpen(false)}
              detail={() => (
                <span>One AI call groups the selected keywords into page-level topics. Nothing is tagged until you apply it.</span>
              )}
            />
          ) : null}

          {isRunning ? (
            <div className="flex items-center gap-2 py-6">
              <span className="h-4 w-4 inline-block animate-spin border-2 border-current border-t-transparent rounded-full" />
              <span>Grouping {ids.length} keywords into topics…</span>
            </div>
          ) : null}

          {isFailed ? (
            <Alert variant="destructive">
              <AlertDescription>
                Grouping failed. You were charged only for the AI call that ran.
              </AlertDescription>
            </Alert>
          ) : null}

          {isCompleted ? (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              {clusters.map((c, i) => (
                <div key={i} className="border rounded p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={checked[i] ?? true}
                      onCheckedChange={(v: boolean | "indeterminate") =>
                        setChecked((prev) => ({ ...prev, [i]: Boolean(v) }))
                      }
                    />
                    <Input
                      value={names[i] ?? c.name}
                      onChange={(e) =>
                        setNames((prev) => ({ ...prev, [i]: e.target.value }))
                      }
                      aria-label="Topic name"
                      className="max-w-xs"
                    />
                    <Badge variant="secondary">{c.intent}</Badge>
                    <Badge variant="outline">{c.priority}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {c.savedKeywordIds.length} keywords
                    </span>
                  </div>
                  {c.targetPage ? (
                    <a href={c.targetPage} className="text-xs text-blue-600" target="_blank" rel="noreferrer">
                      {c.targetPage}
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">New page</span>
                  )}
                </div>
              ))}
              {unsorted.length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  Unsorted ({unsorted.length})
                </div>
              ) : null}
              {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={() => void apply()} disabled={applying}>
                  {applying ? "Applying…" : `Apply tags to ${clusters.filter((_, i) => checked[i]).length} topics`}
                </Button>
              </DialogFooter>
            </div>
          ) : null}

          {!isCompleted && !isRunning && !costOpen && !jobId ? (
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}