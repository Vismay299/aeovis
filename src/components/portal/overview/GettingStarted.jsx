"use client";

/** First-run checklist. The page hides it once every step is complete. */

import { CircleCheck, Circle } from "lucide-react";
import { Button, Card, ProgressBar } from "../ui";

/**
 * `panelApproved` is true/false once the question panel has loaded, null while
 * unknown; an unknown panel falls back to "a scan has already run", since scans
 * start only from an approved panel.
 */
export function buildChecklist({ overview, gsc, scan, panelApproved = null }) {
  const scanCount = overview?.scans?.length ?? 0;
  const draftCount = overview?.content_items?.length ?? 0;
  return [
    { id: "workspace", title: "Workspace created", description: "Your brand workspace is ready.", done: true },
    {
      id: "panel",
      title: "Review and approve your question panel",
      description: "Choose the buyer questions every scan asks. Scans start once the panel is approved.",
      done: panelApproved ?? scanCount > 0,
      action: { label: "Review questions", href: "/portal/measurement" },
    },
    {
      id: "scan",
      title: "Run your first AI visibility scan",
      description: "Ask the answer engines the questions your buyers ask, and see whether they name you.",
      done: scanCount > 0,
      action: { label: "Run scan", onClick: scan.start, loading: scan.starting, disabled: scan.active },
    },
    {
      id: "gsc",
      title: "Connect Google Search Console",
      description: "Import the searches and pages that already bring people to your site.",
      done: !!gsc?.connected,
      action: { label: "Connect", href: "/portal/search-console" },
    },
    {
      id: "draft",
      title: "Create your first content draft",
      description: "Turn a question you are losing into an article AI engines can cite.",
      done: draftCount > 0,
      action: { label: "New draft", href: "/portal/content?new=1" },
    },
  ];
}

export default function GettingStarted({ steps }) {
  const doneCount = steps.filter((step) => step.done).length;
  if (doneCount === steps.length) return null;
  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <Card
      title="Getting started"
      description="A few steps to get your first answers in front of you."
      actions={
        <div className="flex items-center gap-3 text-xs text-muted-foreground whitespace-nowrap">
          <span>{doneCount} of {steps.length} complete</span>
          <div className="w-28">
            <ProgressBar value={pct} size="sm" label="Setup progress" />
          </div>
        </div>
      }
    >
      <ol className="divide-y divide-border">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-3.5 py-3.5 first:pt-0 last:pb-0">
            <span
              className={`flex size-5 shrink-0 items-center justify-center ${step.done ? "text-primary" : "text-muted-foreground"}`}
              aria-hidden="true"
            >
              {step.done ? <CircleCheck className="size-5" /> : <Circle className="size-5" />}
            </span>
            <div className="flex flex-1 flex-col gap-0.5 min-w-0">
              <span className={`text-sm font-medium ${step.done ? "text-muted-foreground" : "text-foreground"}`}>
                {step.title}
                {step.done ? <span className="sr-only"> (done)</span> : null}
              </span>
              <span className="text-xs text-muted-foreground">{step.description}</span>
            </div>
            {!step.done && step.action ? (
              <div className="shrink-0">
                {step.action.href ? (
                  <Button size="sm" variant="secondary" href={step.action.href}>
                    {step.action.label}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={step.action.onClick}
                    loading={step.action.loading}
                    disabled={step.action.disabled}
                  >
                    {step.action.label}
                  </Button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
