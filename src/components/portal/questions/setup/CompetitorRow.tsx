"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/WebsiteCompetitorRow.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CompetitorRow({
  item,
  onChange,
  onRemove,
}: {
  item: { name: string; domain: string; notes: string; sourceUrl?: string };
  onChange: (next: { name: string; domain: string; notes: string; sourceUrl?: string }) => void;
  onRemove: () => void;
}) {
  return (
    <tr className="border-t">
      <td className="p-2"><Input aria-label="Competitor name" value={item.name} onChange={(e) => onChange({ ...item, name: e.target.value })} /></td>
      <td className="p-2"><Input aria-label="Competitor website" value={item.domain} onChange={(e) => onChange({ ...item, domain: e.target.value })} /></td>
      <td className="p-2 text-sm">
        {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Checked page</a> : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="p-2"><Button variant="ghost" size="sm" onClick={onRemove}>Remove</Button></td>
    </tr>
  );
}
