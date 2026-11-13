"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TopicField.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TopicField({
  value,
  onChange,
  topics,
}: {
  value: string;
  onChange: (v: string) => void;
  topics: string[];
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="topic-field">Topic</Label>
      <Input
        id="topic-field"
        list="question-topic-options"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Topic"
      />
      <datalist id="question-topic-options">
        {topics.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}
