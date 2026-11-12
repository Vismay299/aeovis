// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordSearchOptions.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SearchOptions = { resultLimit: 150 | 300 | 500; mode: "auto" | "related" | "suggestions" | "ideas"; clickstream: boolean; groupKeywords: boolean };

export function KeywordSearchOptions({ value, onChange, adsOnly }: { value: SearchOptions; onChange: (value: SearchOptions) => void; adsOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return <>
    <Button variant="outline" type="button" onClick={() => { setDraft(value); setOpen(true); }}>Options</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent fullScreenOnMobile>
        <DialogHeader><DialogTitle>Search options</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <label className="grid gap-2">Results
            <select className="h-10 rounded-md border border-input bg-background px-3" value={draft.resultLimit} onChange={(e) => setDraft({ ...draft, resultLimit: Number(e.target.value) as SearchOptions["resultLimit"] })}>
              {[150, 300, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="grid gap-2">Keyword source
            <select disabled={adsOnly} className="h-10 rounded-md border border-input bg-background px-3 disabled:opacity-50" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as SearchOptions["mode"] })}>
              <option value="auto">Auto</option><option value="related">Phrase match</option><option value="ideas">Category ideas</option><option value="suggestions">People also search for</option>
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={adsOnly} checked={draft.clickstream} onChange={(e) => setDraft({ ...draft, clickstream: e.target.checked })} /><span><span className="font-medium">Clickstream-refined volumes</span><span className="mt-1 block text-muted-foreground">Google reports one combined volume for similar keywords. This estimates each keyword's own volume. Costs 2x.</span></span></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={adsOnly} checked={draft.groupKeywords} onChange={(e) => setDraft({ ...draft, groupKeywords: e.target.checked })} />Group keywords</label>
          {adsOnly ? <p className="text-xs text-muted-foreground">Not available for countries served from Google Ads data.</p> : null}
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => { onChange(draft); setOpen(false); }}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
