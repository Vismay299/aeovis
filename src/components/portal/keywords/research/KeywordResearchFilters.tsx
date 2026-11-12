// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/keywordResearchFilters.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { parseIntentFilter, toggleIntentFilter } from "@/shared/keyword-filtering";
import { INTENT_LABELS, KEYWORD_INTENT_ORDER } from "@/shared/keywords";

export type KeywordFilters = { include: string; exclude: string; minVolume: string; maxVolume: string; minCpc: string; maxCpc: string; minDifficulty: string; maxDifficulty: string; intent: string };
export const EMPTY_KEYWORD_FILTERS: KeywordFilters = { include: "", exclude: "", minVolume: "", maxVolume: "", minCpc: "", maxCpc: "", minDifficulty: "", maxDifficulty: "", intent: "" };

export function KeywordResearchFilters({ value, onChange, onClear }: { value: KeywordFilters; onChange: (value: KeywordFilters) => void; onClear: () => void }) {
  const set = (key: keyof KeywordFilters, next: string) => onChange({ ...value, [key]: next });
  return <div className="grid gap-3 border-b border-border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
    <label className="grid gap-1 text-xs">Include Terms<Input placeholder="audit, checker, template" value={value.include} onChange={(e) => set("include", e.target.value)} /></label>
    <label className="grid gap-1 text-xs">Exclude Terms<Input placeholder="jobs, salary, course" value={value.exclude} onChange={(e) => set("exclude", e.target.value)} /></label>
    <fieldset className="grid gap-1 text-xs"><legend>Search Volume</legend><div className="grid grid-cols-2 gap-2"><Input aria-label="Search Volume minimum" type="number" min="0" placeholder="Min" value={value.minVolume} onChange={(e) => set("minVolume", e.target.value)} /><Input aria-label="Search Volume maximum" type="number" min="0" placeholder="Max" value={value.maxVolume} onChange={(e) => set("maxVolume", e.target.value)} /></div></fieldset>
    <fieldset className="grid gap-1 text-xs"><legend>CPC (USD)</legend><div className="grid grid-cols-2 gap-2"><Input aria-label="CPC (USD) minimum" type="number" min="0" step="0.01" placeholder="Min" value={value.minCpc} onChange={(e) => set("minCpc", e.target.value)} /><Input aria-label="CPC (USD) maximum" type="number" min="0" step="0.01" placeholder="Max" value={value.maxCpc} onChange={(e) => set("maxCpc", e.target.value)} /></div></fieldset>
    <fieldset className="grid gap-1 text-xs"><legend>Difficulty</legend><div className="grid grid-cols-2 gap-2"><Input aria-label="Difficulty minimum" type="number" min="0" max="100" placeholder="Min" value={value.minDifficulty} onChange={(e) => set("minDifficulty", e.target.value)} /><Input aria-label="Difficulty maximum" type="number" min="0" max="100" placeholder="Max" value={value.maxDifficulty} onChange={(e) => set("maxDifficulty", e.target.value)} /></div></fieldset>
    <fieldset className="grid gap-2 text-xs"><legend>Intent</legend>{KEYWORD_INTENT_ORDER.map((intent) => <label key={intent} className="flex items-center gap-2"><Checkbox aria-label={`Intent ${intent}`} checked={parseIntentFilter(value.intent).includes(intent)} onCheckedChange={() => set("intent", toggleIntentFilter(value.intent, intent))} />{INTENT_LABELS[intent]}</label>)}</fieldset>
    <div className="flex items-end"><Button variant="outline" size="sm" onClick={onClear}>Clear filters</Button></div>
  </div>;
}
