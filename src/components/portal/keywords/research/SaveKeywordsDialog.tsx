// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/query/fetchJson";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatLocationLabel } from "@/shared/keyword-locations";

export function SaveKeywordsDialog({ open, onOpenChange, brandKey, keywords, locationCode, languageCode, areaName, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; brandKey: string; keywords: string[]; locationCode: number; languageCode: string; areaName?: string; onSaved?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState("");
  const save = async () => {
    setBusy(true);
    try {
      const result = await fetchJson<{ created: number }>("/api/customer/keywords/saved", { method: "POST", body: { brand_key: brandKey, keywords, locationCode, languageCode, tags: tags.split(",").map((v) => v.trim()).filter(Boolean), tagMode: "append" } });
      toast.success(`Saved ${result.created} keywords`);
      onOpenChange(false); onSaved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Saved keywords are unavailable. Please retry.");
    } finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><DialogContent fullScreenOnMobile>
    <DialogHeader><DialogTitle>Save {keywords.length} keywords</DialogTitle><p className="text-sm text-muted-foreground">These keywords will be saved to this workspace.</p>{areaName ? <p className="text-sm text-muted-foreground">Saved keywords show national metrics. The local volume for {formatLocationLabel(areaName)} is not saved.</p> : null}</DialogHeader>
    <label className="grid gap-1 text-sm">Tags (optional)<Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. priority, blog" /></label>
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button pending={busy} onClick={() => void save()}>Save</Button></DialogFooter>
  </DialogContent></Dialog>;
}
