// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/components/SerpAnalysisCard.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { KeywordPricedButton } from "./KeywordResearchSearchBar";
import type { KeywordSerpResponse } from "./hooks/useKeywordSerpAnalysis";
import { formatUsd } from "@/shared/pricing";

export function SerpAnalysisCard({ brandKey, keyword, locationCode, languageCode, result, top20Result, pending, cacheOnlyMiss, maxUsd, depth, onRun, onLoadTop100, onShowTop20, onRetry, error, deepCrawlFailed }: {
  brandKey: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  result?: KeywordSerpResponse;
  top20Result?: KeywordSerpResponse;
  pending: boolean;
  cacheOnlyMiss: boolean;
  maxUsd?: number;
  depth: 20 | 100;
  onRun: (usd: number) => void;
  onLoadTop100: (usd: number) => void;
  onShowTop20: () => void;
  onRetry: () => void;
  error?: string;
  deepCrawlFailed: boolean;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [keyword, depth]);

  const items = deepCrawlFailed ? (top20Result?.items ?? []) : (result?.items ?? []);
  const pages = Math.max(1, Math.ceil(items.length / 10));
  const pageItems = items.slice(page * 10, (page + 1) * 10);
  const start = items.length ? page * 10 + 1 : 0;
  const end = Math.min((page + 1) * 10, items.length);

  return <Card><CardHeader><CardTitle>SERP Analysis: {keyword}</CardTitle><p className="text-xs text-muted-foreground">{items.length} organic results</p><p className="text-xs text-muted-foreground">Each new keyword's results cost up to {formatUsd(maxUsd ?? 0)}. Results are reused for 12 hours.</p></CardHeader><CardContent className="space-y-3">
    {cacheOnlyMiss ? <div><p className="text-sm">Google results for “{keyword}” are not loaded.</p><KeywordPricedButton label="Load results" pendingLabel="Loading results…" brandKey={brandKey} action="keywords.serp.run" input={{ keyword, locationCode, languageCode, depth: 20 }} pending={pending} onRun={onRun} dialogTitle="Load search results" confirmLabel="Load results" /></div> : null}
    {!cacheOnlyMiss && !pending && !error && items.length === 0 ? <div className="space-y-2 text-sm text-muted-foreground"><p>No SERP details available for this keyword yet.</p><p>Try clicking another keyword to load data.</p></div> : null}
    {pending ? <p role="status" className="text-sm text-muted-foreground">Loading search results…</p> : null}
    {error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>{error}</span>{deepCrawlFailed ? <Button size="sm" variant="outline" onClick={onShowTop20}>Show top 20</Button> : <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}</div> : null}
    {pageItems.map((item) => <a key={`${item.rank}-${item.url}`} className="block border-t border-border pt-2" href={item.url} target="_blank" rel="noreferrer"><span className="text-xs text-muted-foreground">{item.rank}. {item.domain}</span><span className="block font-medium text-primary">{item.title}</span><span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span></a>)}
    {!cacheOnlyMiss && items.length > 0 ? <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm text-muted-foreground"><span>{start}-{end} of {items.length} · Page {page + 1} of {pages}</span><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((current) => Math.max(0, current - 1))} aria-label="Previous SERP page">Previous</Button>{page + 1 < pages ? <Button variant="outline" size="sm" onClick={() => setPage((current) => current + 1)} aria-label="Next SERP page">Next</Button> : depth === 20 ? <KeywordPricedButton label="Load top 100" pendingLabel="Loading top 100…" brandKey={brandKey} action="keywords.serp.run" input={{ keyword, locationCode, languageCode, depth: 100 }} pending={pending} onRun={onLoadTop100} dialogTitle="Load top 100 search results" confirmLabel="Load top 100" /> : null}</div></div> : null}
  </CardContent></Card>;
}
