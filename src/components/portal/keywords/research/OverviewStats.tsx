// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/components/KeywordUi.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScoreBadge } from "@/components/app/table/ScoreBadge";
import { usePortal } from "@/components/portal/PortalShell";
import { IntentBadge } from "./IntentBadge";
import { TrackQuestionDialog } from "../TrackQuestionDialog";

export function OverviewStats({ keyword, volume, cpc, competition, difficulty, intent, brandKey, locationCode, languageCode }: { keyword: string; volume: number | null; cpc: number | null; competition: number | null; difficulty: number | null; intent: string | null; brandKey?: string; locationCode?: number; languageCode?: string }) {
  const { brandKey: portalBrandKey, features } = usePortal();
  const [trackOpen, setTrackOpen] = useState(false);
  const effectiveBrandKey = brandKey ?? portalBrandKey;
  const curationOn = features?.question_curation === true;
  const trackable = curationOn && Boolean(effectiveBrandKey) && locationCode !== undefined && languageCode !== undefined;
  return <Card size="sm" data-testid="keyword-overview"><CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2">
    <strong className="min-w-0 max-w-full truncate">{keyword}</strong>
    <span className="flex items-center gap-1">Score <ScoreBadge value={difficulty} /></span>
    <span><span className="text-muted-foreground">Vol </span>{volume?.toLocaleString() ?? "—"}</span>
    <span><span className="text-muted-foreground">CPC </span>{cpc == null ? "—" : `$${cpc.toFixed(2)}`}</span>
    <span><span className="text-muted-foreground">Comp </span>{competition == null ? "—" : competition.toFixed(2)}</span>
    <IntentBadge intent={intent} />
    {trackable ? <Button size="sm" variant="outline" onClick={() => setTrackOpen(true)}>Track as a question</Button> : null}
    {trackable && trackOpen ? <TrackQuestionDialog open={trackOpen} onOpenChange={setTrackOpen} brandKey={effectiveBrandKey} keyword={keyword} locationCode={locationCode as number} languageCode={languageCode as string} /> : null}
  </CardContent></Card>;
}
