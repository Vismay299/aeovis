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
      {active.length === 0 && failed.length === 0 ? <p className="pv-content-idle">Nothing generating right now.</p> : null}
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
    <article className="pv-content-job">
      <div className="pv-content-job__head">
        <p className="pv-content-job__topic">{topic}</p>
        <span className="pv-content-job__pct">{formatPct(job.progress_pct)}</span>
      </div>
      <div className="pv-content-job__meta">
        <Badge tone="brand" live>{stage?.label || "Queued"}</Badge>
        {playbookLabel(job.playbook, job.agent_format) ? <span>{playbookLabel(job.playbook, job.agent_format)}</span> : null}
      </div>
      <ProgressBar value={job.progress_pct} active indeterminate label={`Progress for ${topic}`} />
      <div className="pv-content-steps">
        <StageSteps steps={CONTENT_JOB_STAGES} current={contentJobStageIndex(job.status)} />
      </div>
      {working?.activity ? <p className="pv-content-job__activity">{working.activity}</p> : null}
    </article>
  );
}

function FailedJob({ job }) {
  return (
    <article className="pv-content-job">
      <div className="pv-content-job__head">
        <p className="pv-content-job__topic">{job.input?.query || "Generating draft"}</p>
        <Badge tone="crit">Failed</Badge>
      </div>
      <p className="pv-content-job__error">{job.error_message || "Generation stopped before a draft was ready."}</p>
      <div className="pv-content-job__meta"><span>{formatRelative(job.created_at)}</span></div>
    </article>
  );
}
