// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchSearchBar.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useState } from "react";
import { LocationSelect } from "@/components/app/LocationSelect";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LOCATION_OPTIONS, getKeywordDataProvider } from "@/shared/keyword-locations";
import { MAX_KEYWORDS_PER_SUBMIT } from "@/shared/keywords";
import { stableStringify } from "@/shared/query/keys";
import type { PriceQuote } from "@/shared/pricing";
import { KeywordSearchOptions, type SearchOptions } from "./KeywordSearchOptions";
import { KeywordAreaField, LocalVolumeCostNote } from "./KeywordAreaField";

/** Show the approved ceiling to cents while preserving its exact numeric value. */
export function KeywordPricedButton({ label, pendingLabel, brandKey, action, input, pending, enabled = true, onRun, dialogTitle, confirmLabel, priceChanged = null, onClose, buttonId }: {
  label: string; pendingLabel: string; brandKey: string; action: string; input: unknown; pending: boolean; enabled?: boolean; onRun: (maxUsd: number) => void; dialogTitle: string; confirmLabel: string; priceChanged?: { approvedMaxUsd: number; quote: PriceQuote } | null; onClose?: () => void; buttonId?: string;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const inputKey = stableStringify(input);
  const [debouncedInput, setDebouncedInput] = useState(input);
  const debouncedInputKey = stableStringify(debouncedInput);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedInput(input), 350);
    return () => window.clearTimeout(timer);
  }, [inputKey]);
  useEffect(() => { setDialogOpen(false); }, [inputKey]);
  const quote = usePriceQuote({ brandKey, action, input: debouncedInput }, { enabled: enabled && Boolean(brandKey) });
  const isStale = inputKey !== debouncedInputKey || quote.isPlaceholderData;
  const data = !isStale && !quote.isFetching ? quote.data : undefined;
  const loading = !data && (quote.isPending || quote.isFetching || isStale);
  const blocked = Boolean(data?.blocked);
  const direct = Boolean(data && data.totalUsd <= 0.25 && !blocked && !data.warnings.some((warning) => !["cache_note", "recent_research"].includes(warning.code)));
  const displayUsd = data ? Math.ceil((data.totalUsd - Number.EPSILON) * 100) / 100 : 0;
  const cents = data ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(displayUsd) : "";
  return <div className="inline-flex flex-col gap-1">
    <Button id={buttonId} type="button" disabled={!enabled || pending || loading || !data || blocked || quote.isError} pending={pending || loading} onClick={() => {
      if (!data || isStale || quote.isFetching || quote.isPlaceholderData) return;
      if (direct) onRun(data.totalUsd);
      else setDialogOpen(true);
    }}>{pending ? pendingLabel : data && !blocked ? `${label} · up to ${cents}` : label}</Button>
    {blocked && data?.blocked ? <p className="text-xs text-destructive">{data.blocked.message}</p> : null}
    {quote.isError ? <p className="text-xs text-destructive">Price unavailable. <button type="button" className="underline" onClick={() => void quote.refetch()}>Retry</button></p> : null}
    <CostReviewDialog open={dialogOpen || Boolean(priceChanged)} title={dialogTitle} confirmLabel={confirmLabel} pendingLabel={pendingLabel} quote={quote} pending={pending} priceChanged={priceChanged} error={null} onConfirm={(maxUsd) => { if (!data || isStale || quote.isFetching || quote.isPlaceholderData) return; setDialogOpen(false); onRun(maxUsd); }} onClose={() => { setDialogOpen(false); onClose?.(); }} />
  </div>;
}

export function KeywordResearchSearchBar({ brandKey, draft, onDraftChange, locationCode, onLocationChange, locationName, onLocationNameChange, localVolumeUsd, options, onOptionsChange, onRun, pending, warnings = [], priceChanged, onClosePriceReview }: {
  brandKey: string; draft: string; onDraftChange: (value: string) => void; locationCode: number; onLocationChange: (code: number) => void; locationName?: string | null; onLocationNameChange?: (locationName: string | undefined) => void; localVolumeUsd?: number; options: SearchOptions; onOptionsChange: (options: SearchOptions) => void; onRun: (maxUsd: number) => void; pending: boolean; warnings?: Array<{code: string; message: string}>; priceChanged?: { approvedMaxUsd: number; quote: any } | null; onClosePriceReview?: () => void;
}) {
  const [searchError, setSearchError] = useState("");
  const adsOnly = getKeywordDataProvider(locationCode) === "google_ads";
  const submittedKeywords = draft.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, MAX_KEYWORDS_PER_SUBMIT);
  const firstKeyword = submittedKeywords[0] ?? "";
  return <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_15rem] lg:grid-cols-[minmax(0,1fr)_15rem_15rem]">
      <div className="space-y-1"><label htmlFor="keyword-search" className="text-sm font-medium">Keywords</label><Textarea id="keyword-search" aria-label="Keywords" placeholder="Enter a keyword" rows={Math.min(MAX_KEYWORDS_PER_SUBMIT, Math.max(2, draft.split("\n").length))} value={draft} onChange={(e) => onDraftChange(e.target.value.split("\n").slice(0, MAX_KEYWORDS_PER_SUBMIT).join("\n"))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!firstKeyword) setSearchError("Enter a keyword to get started"); else { document.getElementById("keyword-research-submit")?.click(); } } }} /></div>
      <div className="space-y-1"><label className="text-sm font-medium">Country</label><LocationSelect value={locationCode} onChange={onLocationChange} options={LOCATION_OPTIONS} /></div>
      {onLocationNameChange ? <div className="space-y-1"><label htmlFor="keyword-area" className="text-sm font-medium">City</label><KeywordAreaField brandKey={brandKey} locationCode={locationCode} value={locationName ?? undefined} onChange={onLocationNameChange} /></div> : null}
    </div>
    {searchError ? <p role="alert" className="text-sm text-destructive">{searchError}</p> : null}
    {adsOnly ? <Alert variant="info"><AlertDescription>Keyword data for this country comes from Google Ads — search volume, CPC, and trends are available, but difficulty and intent are not.</AlertDescription></Alert> : null}
    {locationName && localVolumeUsd !== undefined ? <LocalVolumeCostNote usd={localVolumeUsd} /> : null}
    {warnings.filter((w) => w.code === "recent_research" || w.code === "cache_note").map((w) => <p key={w.code} className="text-xs text-muted-foreground">{w.message}</p>)}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <KeywordSearchOptions value={options} onChange={onOptionsChange} adsOnly={adsOnly} />
      <KeywordPricedButton buttonId="keyword-research-submit" label="Search" pendingLabel="Searching…" brandKey={brandKey} action="keywords.research.run" input={{ keyword: firstKeyword || "keyword", locationCode, ...(locationName ? { locationName } : {}), resultLimit: options.resultLimit, mode: options.mode, clickstream: options.clickstream && !adsOnly, groupKeywords: options.groupKeywords && !adsOnly }} pending={pending} enabled={Boolean(firstKeyword)} onRun={(maxUsd) => { setSearchError(""); if (!firstKeyword) { setSearchError("Enter a keyword to get started"); return; } onRun(maxUsd); }} dialogTitle="Search keyword data" confirmLabel="Search" priceChanged={priceChanged} onClose={onClosePriceReview} />
    </div>
    <p className="sr-only" aria-live="polite">{firstKeyword ? `Ready to search ${firstKeyword}` : ""}</p>
  </div>;
}
