// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KeywordPricedButton } from "./KeywordResearchSearchBar";

export function KeywordNotLoadedCard({ brandKey, keyword, input, onRun, pending }: { brandKey: string; keyword: string; input: unknown; onRun: (maxUsd: number) => void; pending: boolean }) {
  return <Card><CardHeader><CardTitle>Results for “{keyword}” are not loaded</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">Running this search buys fresh keyword data.</p><KeywordPricedButton label="Run search" pendingLabel="Searching…" brandKey={brandKey} action="keywords.research.run" input={input} pending={pending} onRun={onRun} dialogTitle="Run keyword search" confirmLabel="Run search" /></CardContent></Card>;
}
