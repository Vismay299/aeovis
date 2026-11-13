"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/PromptResearchTable.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function QuestionResearchTable({
  questions,
  selected,
  onSelectedChange,
}: {
  questions: any[];
  selected: Record<string, boolean>;
  onSelectedChange: (next: Record<string, boolean>) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!questions.length) {
    return (
      <div className="rounded-md border p-6 text-center">
        <p className="font-medium">No questions found</p>
        <p className="text-sm text-muted-foreground">Try a broader keyword.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left">
          <tr>
            <th className="w-10 p-2"></th>
            <th className="p-2">Question</th>
            <th className="p-2">Sources</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => {
            const own = (q.sources || []).some((s: any) => s.own);
            return (
              <React.Fragment key={q.text}>
                <tr className="border-t align-top">
                  <td className="p-2">
                    <Checkbox
                      disabled={Boolean(q.tracked)}
                      checked={Boolean(selected[q.text])}
                      onCheckedChange={(v) => onSelectedChange({ ...selected, [q.text]: Boolean(v) })}
                      aria-label={`Select ${q.text}`}
                    />
                  </td>
                  <td className="p-2">
                    <div className="space-y-1">
                      <div>{q.text}</div>
                      <div className="flex flex-wrap gap-1">
                        {q.tracked ? <Badge variant="secondary">Tracked</Badge> : null}
                        {(q.variants?.length || 0) > 0 ? <Badge variant="outline">+{q.variants.length} similar questions merged</Badge> : null}
                      </div>
                    </div>
                  </td>
                  <td className="p-2">
                    {(q.sources || []).length ? `${q.sources.length} sources` : "No sources"}
                    {own ? <Badge className="ml-1" variant="outline">You</Badge> : null}
                  </td>
                  <td className="p-2">
                    <Button variant="ghost" size="sm" onClick={() => setExpanded((e) => ({ ...e, [q.text]: !e[q.text] }))}>
                      {expanded[q.text] ? "Hide" : "Expand"}
                    </Button>
                  </td>
                </tr>
                {expanded[q.text] ? (
                  <tr className="border-t">
                    <td></td>
                    <td colSpan={3} className="p-2 space-y-2">
                      {(q.sources || []).length ? (
                        <ul className="space-y-1">
                          {(q.sources || []).map((s: any, i: number) => (
                            <li key={i}>
                              <a href={s.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s.title || s.domain}</a>
                              {s.own ? <Badge className="ml-1" variant="outline">Your site is cited</Badge> : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted-foreground">The AI answered from memory and cited no sources.</p>
                      )}
                      <p className="text-sm text-muted-foreground">
                        {q.brandMentioned ? "Your brand is mentioned" : "Your brand is not mentioned"}
                      </p>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
