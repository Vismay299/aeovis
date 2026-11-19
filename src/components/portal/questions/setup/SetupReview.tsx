"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/WebsiteSetupReview.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/portal/ui";
const PCard = Card as any;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { usePortal } from "@/components/portal/PortalShell";
import type { QuestionsState } from "../hooks/useQuestions";
import { useQuestionMutations } from "../hooks/useQuestionMutations";
import type { SetupReview as SetupReviewData } from "../hooks/useSetupJob";
import { CompetitorRow } from "./CompetitorRow";

const COUNTRIES = [
  { value: "in", label: "India" },
  { value: "us", label: "United States" },
  { value: "gb", label: "United Kingdom" },
  { value: "sg", label: "Singapore" },
  { value: "ae", label: "United Arab Emirates" },
  { value: "ca", label: "Canada" },
  { value: "au", label: "Australia" },
];

export function SetupReview({
  brandKey,
  state,
  jobId,
  review,
  onSaved,
}: {
  brandKey: string;
  state: QuestionsState;
  jobId: string;
  review: SetupReviewData | null;
  onSaved: () => void;
}) {
  const { scan, features } = usePortal();
  const mutations = useQuestionMutations(brandKey);
  const [overview, setOverview] = useState("");
  const [persona, setPersona] = useState("");
  const [country, setCountry] = useState("in");
  const [language, setLanguage] = useState("en");
  const [competitors, setCompetitors] = useState<Array<{ name: string; domain: string; notes: string; sourceUrl?: string }>>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [baselinePending, setBaselinePending] = useState(false);
  const [baselineError, setBaselineError] = useState<string | null>(null);

  const baselineQuote = usePriceQuote(
    { brandKey, action: "ai_visibility.scan.run", input: { panelKey: "default" } },
    { enabled: Boolean(baselineOpen) }
  );

  useEffect(() => {
    if (!review) return;
    setOverview(review.overview?.text || "");
    setPersona(review.persona || "");
    setCompetitors((review.competitors?.items || []).map((c) => ({ name: c.name, domain: c.domain, notes: c.notes || "", sourceUrl: c.sourceUrl })));
    const sel: Record<string, boolean> = {};
    for (const c of review.candidates || []) sel[c.id] = Boolean(c.selected);
    setSelected(sel);
  }, [review]);

  const candidates = review?.candidates || [];
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const canSubmit = selectedCount > 0 && Boolean(persona.trim());

  const grouped = useMemo(() => {
    const m = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const arr = m.get(c.topic) || [];
      arr.push(c);
      m.set(c.topic, arr);
    }
    return Array.from(m.entries());
  }, [candidates]);

  async function save(approve: boolean) {
    if (!review) return;
    setSaving(true);
    setError(null);
    try {
      const selectedCandidateIds = candidates.filter((c) => selected[c.id]).map((c) => c.id);
      const res = await mutations.saveSetup.mutateAsync({
        jobId,
        expectedRevision: state.revision,
        overview: review.overview?.preserved ? undefined : overview.trim(),
        competitors: competitors.map((c) => ({ name: c.name, domain: c.domain, notes: c.notes })),
        selectedCandidateIds,
        persona: persona.trim(),
        country,
        language,
        approve,
      });
      onSaved();
      if (approve && res?.panel?.version) {
        toast.success(`Questions approved. Scans ask version ${res.panel.version} from now on.`);
        setBaselineOpen(true);
      } else if (!approve) {
        toast.success("Setup saved.");
      }
      if (approve && res?.panel == null && (res as any)?.approveError) {
        toast.error((res as any).approveError.message || "Could not approve questions.");
      }
    } catch (e: any) {
      setError("We couldn't save your setup. Check the competitor names and websites, then try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!review) {
    return (
      // T4: the review's own sections shimmer until it loads.
      <PCard title="Review your setup" className="mx-auto max-w-3xl">
        <div className="space-y-6 p-4" role="status" aria-label="Loading review…">
          <Skeleton className="h-4 w-2/3" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-32 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        </div>
      </PCard>
    );
  }

  return (
    <PCard title="Review your setup" className="mx-auto max-w-3xl">
      <div className="animate-page-in space-y-6 p-4">
        <p className="text-sm text-muted-foreground">
          You can change your context at any time in Context.{" "}
          {features?.project_memory ? <Link href="/portal/context" className="text-primary hover:underline">Context</Link> : null}
        </p>

        <div className="space-y-2">
          <Label htmlFor="setup-review-overview">What you sell, who buys it, and where</Label>
          <Textarea id="setup-review-overview" value={overview} onChange={(e) => setOverview(e.target.value)} readOnly={review.overview?.preserved} rows={4} />
          {review.overview?.preserved ? <p className="text-sm text-muted-foreground">We'll use the business overview saved in Context.</p> : null}
        </div>

        <div className="space-y-2">
          <h3 className="font-medium">Competitors</h3>
          {review.competitors?.preserved ? <p className="text-sm text-muted-foreground">We'll use the competitors saved in Context.</p> : null}
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left"><tr><th className="p-2">Name</th><th className="p-2">Website</th><th className="p-2">Source</th><th className="p-2"></th></tr></thead>
              <tbody>
                {competitors.map((c, i) => (
                  <CompetitorRow key={i} item={c} onChange={(next) => setCompetitors((arr) => arr.map((x, j) => j === i ? next : x))} onRemove={() => setCompetitors((arr) => arr.filter((_, j) => j !== i))} />
                ))}
              </tbody>
            </table>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setCompetitors((arr) => arr.length < 100 ? [...arr, { name: "", domain: "", notes: "" }] : arr)}>Add competitor</Button>
          {(review.warnings || []).map((w, i) => <Alert key={i}><AlertDescription>{w.message}</AlertDescription></Alert>)}
        </div>

        <div className="space-y-2">
          <Label htmlFor="setup-review-persona">Who asks these questions</Label>
          <Input id="setup-review-persona" aria-label="Who asks these questions" value={persona} onChange={(e) => setPersona(e.target.value)} />
          <p className="text-sm text-muted-foreground">Scans are measured for this audience. Required to approve.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Country</Label>
            <Select value={country} onValueChange={(v) => setCountry(v ?? "in")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{COUNTRIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setup-review-language">Language</Label>
            <Input id="setup-review-language" value={language} onChange={(e) => setLanguage(e.target.value)} />
            <p className="text-xs text-muted-foreground">Language code, e.g. en</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">Questions</h3>
            <span className="text-sm text-muted-foreground">{selectedCount} of {candidates.length} selected · you can track up to 100</span>
          </div>
          <p className="text-sm text-muted-foreground">Branded questions are asked as diagnostics and never count toward your visibility score.</p>
          <div className="space-y-4">
            {grouped.map(([topic, items]) => (
              <div key={topic} className="space-y-2 rounded-md border p-3">
                <label className="flex items-center gap-2 font-medium">
                  <Checkbox
                    aria-label={`Select all in ${topic}`}
                    checked={items.every((i) => selected[i.id] || (i.existing && i.existing.status !== "archived"))}
                    onCheckedChange={(v) => {
                      const next = { ...selected };
                      for (const i of items) if (!(i.existing && i.existing.status !== "archived")) next[i.id] = Boolean(v);
                      setSelected(next);
                    }}
                  />
                  {topic}
                </label>
                <div className="space-y-2">
                  {items.map((c) => {
                    const disabled = Boolean(c.existing && c.existing.status !== "archived");
                    return (
                      <label key={c.id} className="flex items-start gap-2 text-sm">
                        <Checkbox checked={Boolean(selected[c.id])} disabled={disabled} onCheckedChange={(v) => setSelected((s) => ({ ...s, [c.id]: Boolean(v) }))} />
                        <span className="space-y-1">
                          <span className="block">{c.text}</span>
                          <span className="flex flex-wrap gap-1">
                            {c.origin === "ai_setup" ? <Badge variant="outline">From your website</Badge> : <Badge variant="outline">Search-grounded</Badge>}
                            {c.branded ? <Badge variant="outline">Branded · diagnostic</Badge> : null}
                            {c.existing && c.existing.status !== "archived" ? <Badge variant="secondary">Already tracked</Badge> : null}
                            {c.existing && c.existing.status === "archived" ? <Badge variant="secondary">Will be restored</Badge> : null}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => save(false)} disabled={saving}>Save without approving</Button>
          <Button onClick={() => save(true)} disabled={saving || !canSubmit}>{saving ? "Saving…" : "Save and approve"}</Button>
        </div>

        <CostReviewDialog
          open={baselineOpen}
          title="Run your first scan"
          confirmLabel="Run first scan"
          pendingLabel="Starting…"
          quote={baselineQuote as any}
          pending={baselinePending}
          priceChanged={null}
          error={baselineError}
          onConfirm={async (maxUsd) => {
            setBaselineError(null);
            setBaselinePending(true);
            try {
              await (scan as any).confirmStart(maxUsd);
              setBaselineOpen(false);
            } catch (e: any) {
              setBaselineError(e?.message || "Could not start the scan.");
            } finally {
              setBaselinePending(false);
            }
          }}
          onClose={() => { if (!baselinePending) setBaselineOpen(false); }}
        />
      </div>
    </PCard>
  );
}
