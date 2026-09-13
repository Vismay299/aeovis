/**
 * The content lifecycle as DATA (plan: docs/plans/2026-07-28-agent-control-plane.md, T2).
 *
 * `blocks.js` already models pipeline COMPOSITION as data — which specialists
 * run, in what order, with what contract. What stayed imperative was the
 * lifecycle: a hardcoded block→status map, a nested ternary in the decision
 * route deriving verdict→status, and a job-status mirror that could write a
 * status the worker itself would never produce (D5).
 *
 * This module is the missing half, following Paperclip's PipelineStageConfig
 * shape (server/src/services/pipelines.ts):
 *
 *   kind:             open | working | review | done | cancelled
 *   approveTo / rejectTo / requestChangesTo:  where a review decision routes
 *   reviewerKind:     human | any
 *   terminal:         no transition out
 *
 * SCOPE (L5): stages describe STATUS TRANSITIONS only. Block execution stays
 * in contentWorker/blocks.js, so adopting this cannot destabilise a working
 * pipeline — it replaces lookups and validates writes, it does not drive them.
 */

export const STAGE_KINDS = ["open", "working", "review", "done", "cancelled"];

/**
 * content_jobs.status lifecycle.
 *
 * `blocks` lists the pipeline block slugs that put a job in this status — the
 * reverse index replaces contentWorker's hardcoded statusForBlock map.
 */
export const JOB_STAGES = {
  pending: { kind: "open" },
  coordinating: { kind: "working", blocks: ["coordinate"] },
  researching: { kind: "working", blocks: ["research"] },
  benchmarking: { kind: "working", blocks: ["benchmark"] },
  drafting: { kind: "working", blocks: ["draft"] },
  reviewing: { kind: "working", blocks: ["review", "fact_check"] },
  awaiting_approval: {
    kind: "review",
    reviewerKind: "human",
    approveTo: "approved",
    rejectTo: "rejected",
    // A revision pass runs and returns the job to the same gate — the human
    // gate is mandatory and re-applies regardless of the revision's verdict.
    requestChangesTo: "awaiting_approval",
  },
  approved: { kind: "working" },
  // R5.2.2 — published item means the job is done
  published: { kind: "done", terminal: true },
  rejected: { kind: "cancelled", terminal: true },
  failed: { kind: "cancelled", terminal: true },
};

/** content_items.status lifecycle. */
export const ITEM_STAGES = {
  draft: { kind: "open" },
  awaiting_approval: {
    kind: "review",
    reviewerKind: "human",
    approveTo: "approved",
    rejectTo: "rejected",
    requestChangesTo: "changes_requested",
  },
  // The async revision pass is in flight; it returns the item to the gate.
  changes_requested: { kind: "working" },
  // R5.2.2 — approved is no longer terminal: the operator must publish with a
  // verified live URL before the item is truly done.
  approved: { kind: "working" },
  // R5.2.2 — the true terminal state, reached only via the publish step.
  published: { kind: "done", terminal: true },
  rejected: { kind: "cancelled", terminal: true },
};

/**
 * Status for a block that no stage claims by slug. Keyed by the block's `kind`
 * from blocks.js, so a NEW transform or check added to the registry gets a
 * sensible coarse status with no edit here — matching the old fallback
 * (transform → drafting, everything else → reviewing).
 */
const KIND_FALLBACK_STATUS = {
  context: "coordinating",
  draft: "drafting",
  transform: "drafting",
  check: "reviewing",
};

const BLOCK_TO_STATUS = Object.entries(JOB_STAGES).reduce((acc, [status, stage]) => {
  for (const slug of stage.blocks || []) acc[slug] = status;
  return acc;
}, {});

/** The coarse job status to show while `slug` (of kind `blockKind`) is active. */
export function stageForBlock(slug, blockKind) {
  return BLOCK_TO_STATUS[slug] || KIND_FALLBACK_STATUS[blockKind] || "reviewing";
}

export function isTerminal(status, stages = JOB_STAGES) {
  return !!stages[status]?.terminal;
}

/** Statuses whose stage is a review gate — the only ones that accept a decision. */
export function reviewStatuses(stages = ITEM_STAGES) {
  return Object.keys(stages).filter((s) => stages[s].kind === "review");
}

/**
 * Every status reachable from `from` in one step.
 *
 * Working/open stages transition broadly to each other on purpose: pipelines
 * are composable (blocks.js lets the operator reorder and remove blocks), so
 * enumerating pairs would invalidate a legal custom pipeline. What this DOES
 * pin down is the part that actually went wrong: nothing escapes a terminal
 * stage, and a review stage exits only through its declared decision routes.
 */
export function allowedTransitions(from, stages = JOB_STAGES) {
  const stage = stages[from];
  if (!stage) return new Set();
  if (stage.terminal) return new Set();

  const out = new Set([from]); // idempotent re-writes of the same status

  if (stage.kind === "review") {
    for (const key of ["approveTo", "rejectTo", "requestChangesTo"]) {
      if (stage[key]) out.add(stage[key]);
    }
  } else {
    for (const [status, s] of Object.entries(stages)) {
      if (s.kind === "working" || s.kind === "open" || s.kind === "review") out.add(status);
    }
  }

  // A failure can interrupt any non-terminal stage.
  for (const [status, s] of Object.entries(stages)) {
    if (s.kind === "cancelled" && status === "failed") out.add(status);
  }

  return out;
}

export function isLegalTransition(from, to, stages = JOB_STAGES) {
  if (!stages[to]) return false;
  if (from === undefined || from === null) return true; // first write on a fresh row
  return allowedTransitions(from, stages).has(to);
}

/**
 * The wire verdicts Studio posts (`/api/content-items/[id]/decision`) mapped
 * onto Paperclip's decision vocabulary. The public API keeps its existing
 * verdict names — this accepts either, so the contract is unchanged.
 */
const DECISION_ALIASES = {
  approve: "approve",
  approved: "approve",
  reject: "reject",
  rejected: "reject",
  request_changes: "request_changes",
  changes_requested: "request_changes",
};

export function normalizeDecision(verdict) {
  return DECISION_ALIASES[String(verdict || "").trim()] || null;
}

const DECISION_TO_STAGE_KEY = {
  approve: "approveTo",
  reject: "rejectTo",
  request_changes: "requestChangesTo",
};

/**
 * Route a review decision to its target status. Returns
 * `{ ok, status }` or `{ ok: false, error, code }` — the caller turns a
 * failure into a 400/409 rather than re-deriving the rules with a ternary.
 */
export function decideItemStatus(currentStatus, verdict, stages = ITEM_STAGES) {
  const decision = normalizeDecision(verdict);
  if (!decision) {
    return { ok: false, code: "bad_verdict", error: `Unknown verdict "${verdict}".` };
  }

  const stage = stages[currentStatus];
  if (!stage) {
    return { ok: false, code: "unknown_stage", error: `Unknown status "${currentStatus}".` };
  }
  if (stage.kind !== "review") {
    return {
      ok: false,
      code: "not_a_review_stage",
      error: `Item is "${currentStatus}" — only ${reviewStatuses(stages).join(", ")} items accept decisions.`,
    };
  }

  const target = stage[DECISION_TO_STAGE_KEY[decision]];
  if (!target) {
    return {
      ok: false,
      code: "decision_not_allowed",
      error: `Stage "${currentStatus}" does not allow "${decision}".`,
    };
  }
  return { ok: true, status: target, decision };
}

/**
 * The job status that mirrors an item status. `changes_requested` maps back to
 * the job's review gate because the job is not finished — the async revision
 * pass will return the item to that same gate. The decision route previously
 * open-coded this and could write a job status the worker never produces.
 */
export function jobStatusForItemStatus(itemStatus) {
  if (itemStatus === "changes_requested") return "awaiting_approval";
  return JOB_STAGES[itemStatus] ? itemStatus : "awaiting_approval";
}

/**
 * Self-validation, run once at import — the same guarantees Paperclip enforces
 * when a pipeline is created (review stages REQUIRE approveToStageKey;
 * reviewerKind must be human|any). A typo in a stage table is otherwise a
 * silent wrong-status bug in production, so it throws at module load instead.
 */
function assertStagesValid(name, stages) {
  for (const [status, stage] of Object.entries(stages)) {
    if (!STAGE_KINDS.includes(stage.kind)) {
      throw new Error(`${name}.${status}: unknown stage kind "${stage.kind}"`);
    }
    if (stage.kind === "review") {
      if (!stage.approveTo) {
        throw new Error(`${name}.${status}: review stages require approveTo`);
      }
      if (stage.reviewerKind && !["human", "any"].includes(stage.reviewerKind)) {
        throw new Error(`${name}.${status}: reviewerKind must be human or any`);
      }
    }
    if ((stage.kind === "done" || stage.kind === "cancelled") && !stage.terminal) {
      throw new Error(`${name}.${status}: ${stage.kind} stages must be terminal`);
    }
    for (const key of ["approveTo", "rejectTo", "requestChangesTo"]) {
      if (stage[key] && !stages[stage[key]]) {
        throw new Error(`${name}.${status}.${key} points at unknown stage "${stage[key]}"`);
      }
    }
  }
}

assertStagesValid("JOB_STAGES", JOB_STAGES);
assertStagesValid("ITEM_STAGES", ITEM_STAGES);
