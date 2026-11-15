"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/PromptSummary.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { aiRate, type BrandSummaryItem } from "./hooks/useQuestionHistory";

const VISIBLE_BRANDS = 4;

export function BrandComparison({
  summary,
}: {
  summary: BrandSummaryItem[];
}) {
  const [expanded, setExpanded] = useState(false);

  // Self row first, then sorted by mentions desc, citations desc, name asc
  const ranked = [...summary].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (b.mentions !== a.mentions) return b.mentions - a.mentions;
    if (b.citations !== a.citations) return b.citations - a.citations;
    return a.name.localeCompare(b.name);
  });

  const visible = expanded ? ranked : ranked.slice(0, VISIBLE_BRANDS);
  const hiddenCount = ranked.length - visible.length;

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
          Brand comparison
        </h2>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Brand</TableHead>
                <TableHead>Mentioned</TableHead>
                <TableHead>Cited</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((brand) => (
                <TableRow key={brand.name}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{brand.name}</span>
                      {brand.isSelf && (
                        <Badge variant="secondary" size="sm">
                          You
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell
                    className="tabular-nums"
                    title={`${brand.mentions} of ${brand.answers} answers`}
                  >
                    <span className="font-medium">{aiRate(brand.mentions, brand.answers)}</span>
                    {brand.answers > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {brand.mentions} of {brand.answers}
                        {brand.unknown > 0 && ` (${brand.unknown} unknown)`}
                      </p>
                    )}
                  </TableCell>
                  <TableCell
                    className="tabular-nums"
                    title={`${brand.citations} of ${brand.answers} answers`}
                  >
                    <span className="font-medium">{aiRate(brand.citations, brand.answers)}</span>
                    {brand.answers > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {brand.citations} of {brand.answers}
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!summary.length && (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                    No brand evidence is available for this period yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {hiddenCount > 0 && (
          <div className="border-t border-border px-4 py-2">
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0 text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(true)}
            >
              Show {hiddenCount} more
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Rates count scan answers only. Prompt Explorer answers are listed below but not counted. Answers where a mention could not be confirmed are shown as unknown and left out of the rate.
      </p>
    </div>
  );
}
