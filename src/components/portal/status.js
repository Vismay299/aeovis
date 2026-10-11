/**
 * One vocabulary for statuses across portal pages. `tone` is a <Badge> tone.
 */

export const CONTENT_ITEM_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Needs review", tone: "warn" },
  changes_requested: { label: "Revising", tone: "brand" },
  approved: { label: "Approved", tone: "good" },
  published: { label: "Published", tone: "good" },
  rejected: { label: "Rejected", tone: "crit" },
};

export function contentItemStatus(status) {
  return CONTENT_ITEM_STATUS[status] || { label: status ? String(status).replace(/_/g, " ") : "Draft", tone: "neutral" };
}

/** content_jobs.status, in pipeline order, for a <StageSteps> stepper. */
export const CONTENT_JOB_STAGES = [
  { status: "pending", label: "Queued" },
  { status: "coordinating", label: "Planning" },
  { status: "researching", label: "Researching" },
  { status: "benchmarking", label: "Benchmarking" },
  { status: "drafting", label: "Writing" },
  { status: "reviewing", label: "Fact-checking" },
];

export const CONTENT_JOB_ACTIVE = CONTENT_JOB_STAGES.map((stage) => stage.status);

/** Index into CONTENT_JOB_STAGES; CONTENT_JOB_STAGES.length once the draft is ready. */
export function contentJobStageIndex(status) {
  const index = CONTENT_JOB_STAGES.findIndex((stage) => stage.status === status);
  if (index >= 0) return index;
  return ["awaiting_approval", "approved", "published", "rejected"].includes(status) ? CONTENT_JOB_STAGES.length : -1;
}

export const SCAN_JOB_STATUS = {
  pending: { label: "Queued", tone: "brand" },
  generating_prompts: { label: "Writing questions", tone: "brand" },
  probing: { label: "Asking engines", tone: "brand" },
  scoring: { label: "Scoring", tone: "brand" },
  complete: { label: "Complete", tone: "good" },
  failed: { label: "Failed", tone: "crit" },
};

export function scanJobStatus(status) {
  return SCAN_JOB_STATUS[status] || { label: status ? String(status).replace(/_/g, " ") : "Unknown", tone: "neutral" };
}
