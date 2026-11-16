"use client";

import { Badge, Card, ProgressBar, SkeletonRows, StageSteps, formatPct, formatRelative } from "../ui";
import { CONTENT_JOB_STAGES, contentJobStageIndex } from "../status";
import { playbookLabel } from "./shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The "In progress" card: live generation jobs plus failures from the last 24 hours. */
export default function GenerationQueue({ jobs }) {
  if (jobs === null) {
    return (
      <Card title="In progress">
        <SkeletonRows rows={2} />
      </Card>
    );
  }
  const active = jobs.filter((job) => CONTENT_JOB_STAGES.some((stage) => stage.status === job.status));
  const cutoff = Date.now() - DAY_MS;
  const failed = jobs.filter((job) => job.status === "failed" && new Date(job.created_at).getTime() >= cutoff);

  return (
    <Card title="In progress" description="Updates live while a draft is being written.">
      {active.length === 0 && failed.length === 0 ? <p className="text-[13px] text-muted-foreground">Nothing generating right now.</p> : null}
      {active.map((job) => <ActiveJob key={job.id} job={job} />)}
      {failed.map((job) => <FailedJob key={job.id} job={job} />)}
    </Card>
  );
}

function ActiveJob({ job }) {
  const stage = CONTENT_JOB_STAGES.find((entry) => entry.status === job.status);
  const trace = Array.isArray(job.agent_trace) ? job.agent_trace : [];
  const working = trace.find((step) => step?.status === "working");
  const topic = job.input?.query || "Generating draft";

  return (
    <article className="grid gap-3 border-t border-border py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-semibold leading-snug text-foreground">{topic}</p>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatPct(job.progress_pct)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge tone="brand" live>{stage?.label || "Queued"}</Badge>
        {playbookLabel(job.playbook, job.agent_format) ? <span>{playbookLabel(job.playbook, job.agent_format)}</span> : null}
      </div>
      <ProgressBar value={job.progress_pct} active indeterminate label={`Progress for ${topic}`} />
      <div className="[&_.pv-step__label]:sr-only">
        <StageSteps steps={CONTENT_JOB_STAGES} current={contentJobStageIndex(job.status)} />
      </div>
      {working?.activity ? <p className="text-xs leading-relaxed text-muted-foreground">{working.activity}</p> : null}
    </article>
  );
}

function FailedJob({ job }) {
  return (
    <article className="grid gap-3 border-t border-border py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-semibold leading-snug text-foreground">{job.input?.query || "Generating draft"}</p>
        <Badge tone="crit">Failed</Badge>
      </div>
      <p className="break-words text-xs leading-relaxed text-destructive">{job.error_message || "Generation stopped before a draft was ready."}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{formatRelative(job.created_at)}</span></div>
    </article>
  );
}
