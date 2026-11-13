"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TrackerPromptFields.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function QuestionFields({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  function setAt(i: number, v: string) {
    const next = [...values];
    next[i] = v;
    onChange(next);
  }
  function add() {
    if (values.length >= 5) return;
    onChange([...values, ""]);
  }
  return (
    <div className="space-y-2">
      <Label>Questions to track</Label>
      <div className="space-y-2">
        {values.map((v, i) => (
          <Input
            key={i}
            aria-label={`Question ${i + 1}`}
            placeholder={`Question ${i + 1}`}
            value={v}
            onChange={(e) => setAt(i, e.target.value)}
          />
        ))}
      </div>
      {values.length < 5 ? (
        <Button type="button" variant="secondary" size="sm" onClick={add}>
          Add question
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">Paste multiple lines to split into questions.</p>
    </div>
  );
}
