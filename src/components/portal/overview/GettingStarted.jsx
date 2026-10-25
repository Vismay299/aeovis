"use client";

/** First-run checklist. The page hides it once every step is complete. */

import { CircleCheck, Circle } from "lucide-react";
import { Button, Card, ProgressBar } from "../ui";
import "./overview.css";

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
        <div className="pv-overview-progress">
          <span>{doneCount} of {steps.length} complete</span>
          <ProgressBar value={pct} size="sm" label="Setup progress" />
        </div>
      }
    >
      <ol className="pv-overview-steps">
        {steps.map((step) => (
          <li key={step.id} className={`pv-overview-step${step.done ? " is-done" : ""}`}>
            <span className="pv-overview-step__icon" aria-hidden="true">
              {step.done ? <CircleCheck /> : <Circle />}
            </span>
            <div className="pv-overview-step__main">
              <span className="pv-overview-step__title">
                {step.title}
                {step.done ? <span className="sr-only"> (done)</span> : null}
              </span>
              <span className="pv-overview-step__desc">{step.description}</span>
            </div>
            {!step.done && step.action ? (
              <div className="pv-overview-step__action">
                {step.action.href ? (
                  <Button size="sm" variant="secondary" href={step.action.href}>{step.action.label}</Button>
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
