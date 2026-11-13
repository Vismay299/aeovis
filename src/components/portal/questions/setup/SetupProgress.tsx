"use client";

import * as React from "react";
import { Card } from "@/components/portal/ui";
import { Progress } from "@/components/ui/progress";
import { Check, Loader2, Circle } from "lucide-react";

const LABELS = [
  "Reading your website",
  "Finding competitors",
  "Drafting questions",
  "Adding search-grounded questions",
  "Preparing your review",
];

export function SetupProgress({ displayName, job }: { displayName: string; job: any }) {
  const done = job?.data?.progress?.done ?? 0;
  const total = job?.data?.progress?.total ?? 5;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const PCard = Card as any;

  return (
    <PCard title={`Researching ${displayName}`}>
      <div className="space-y-4 p-4">
        <Progress value={pct} aria-label="Setup progress" />
        <ul className="space-y-2" aria-live="polite">
          {LABELS.map((label, i) => {
            const step = i + 1;
            const state = done >= step ? "done" : done + 1 === step ? "active" : "todo";
            return (
              <li key={label} className="flex items-center gap-2 text-sm">
                {state === "done" ? <Check className="size-4 text-green-600" /> : state === "active" ? <Loader2 className="size-4 animate-spin" /> : <Circle className="size-4 text-muted-foreground" />}
                <span className={state === "todo" ? "text-muted-foreground" : ""}>{label}</span>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-muted-foreground">Step {Math.min(done, total)} of {total}</p>
        <p className="text-sm text-muted-foreground">You can leave this page; research keeps running.</p>
      </div>
    </PCard>
  );
}
