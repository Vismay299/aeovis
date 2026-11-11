// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/components/SerpAnalysisCard.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { KeywordPricedButton } from "./KeywordResearchSearchBar";
import type { KeywordSerpResponse } from "./hooks/useKeywordSerpAnalysis";
import { formatUsd } from "@/shared/pricing";

export function SerpAnalysisCard({ brandKey, keyword, result, pending, cacheOnlyMiss, maxUsd, onRun, onRetry, error }: { brandKey: string; keyword: string; result?: KeywordSerpResponse; pending: boolean; cacheOnlyMiss: boolean; maxUsd?: number; onRun: (usd: number) => void; onRetry: () => void; error?: string }) {
  const items = result?.items ?? [];
  return <Card><CardHeader><CardTitle>SERP Analysis: {keyword}</CardTitle><p className="text-xs text-muted-foreground">{items.length} organic results</p><p className="text-xs text-muted-foreground">Each new keyword's results cost up to {formatUsd(maxUsd ?? 0)}. Results are reused for 12 hours.</p></CardHeader><CardContent className="space-y-3">
    {error ? <div role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></div> : null}
    {cacheOnlyMiss ? <div><p className="text-sm">Google results for “{keyword}” are not loaded.</p><KeywordPricedButton label="Load results" pendingLabel="Loading results…" brandKey={brandKey} action="keywords.serp.run" input={{ keyword, depth: 20 }} pending={pending} onRun={onRun} dialogTitle="Load search results" confirmLabel="Load results" /></div> : null}
    {!cacheOnlyMiss && !pending && !error && items.length === 0 ? <div className="space-y-2 text-sm text-muted-foreground"><p>No SERP details available for this keyword yet.</p><p>Try clicking another keyword to load data.</p></div> : null}
    {pending ? <p role="status" className="text-sm text-muted-foreground">Loading search results…</p> : null}
    {items.slice(0, 10).map((item) => <a key={`${item.rank}-${item.url}`} className="block border-t border-border pt-2" href={item.url} target="_blank" rel="noreferrer"><span className="text-xs text-muted-foreground">{item.rank}. {item.domain}</span><span className="block font-medium text-primary">{item.title}</span><span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span></a>)}
  </CardContent></Card>;
}
