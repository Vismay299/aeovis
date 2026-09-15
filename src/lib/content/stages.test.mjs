import test from "node:test";
import assert from "node:assert/strict";
import {
  JOB_STAGES,
  ITEM_STAGES,
  STAGE_KINDS,
  stageForBlock,
  isTerminal,
  isLegalTransition,
  allowedTransitions,
  decideItemStatus,
  jobStatusForItemStatus,
  normalizeDecision,
  reviewStatuses,
} from "./stages.js";
import { BLOCKS, BLOCK_SLUGS } from "./agents/blocks.js";
import { CONTENT_JOB_RUNNING } from "../db/content.js";

/**
 * The declarative stage machine (T2). These tests pin the invariants that used
 * to live in control flow: which statuses are review gates, where a verdict
 * routes, and that nothing escapes a terminal stage.
 */

// --- block → status ---------------------------------------------------------

test("stageForBlock reproduces the old hardcoded map exactly", () => {
  assert.equal(stageForBlock("coordinate", "context"), "coordinating");
  assert.equal(stageForBlock("research", "context"), "researching");
  assert.equal(stageForBlock("benchmark", "context"), "benchmarking");
  assert.equal(stageForBlock("draft", "draft"), "drafting");
  assert.equal(stageForBlock("review", "check"), "reviewing");
  assert.equal(stageForBlock("fact_check", "check"), "reviewing");
});

test("stageForBlock falls back by block kind: transforms draft, checks review", () => {
  assert.equal(stageForBlock("translate", "transform"), "drafting");
  assert.equal(stageForBlock("tighten", "transform"), "drafting");
  assert.equal(stageForBlock("some_future_check", "check"), "reviewing");
  assert.equal(stageForBlock("totally_unknown", undefined), "reviewing");
});

test("every block in the registry resolves to a real job stage", () => {
  for (const slug of BLOCK_SLUGS) {
    const status = stageForBlock(slug, BLOCKS[slug].kind);
    assert.ok(JOB_STAGES[status], `block "${slug}" mapped to unknown stage "${status}"`);
    assert.equal(
      JOB_STAGES[status].kind,
      "working",
      `an active block must map to a working stage, "${slug}" gave "${status}"`
    );
  }
});

test("every worker-active status in CONTENT_JOB_RUNNING is a non-terminal stage", () => {
  for (const status of CONTENT_JOB_RUNNING) {
    assert.ok(JOB_STAGES[status], `CONTENT_JOB_RUNNING has unknown status "${status}"`);
    assert.equal(isTerminal(status), false, `"${status}" must not be terminal`);
  }
});

// --- table integrity --------------------------------------------------------

test("both stage tables use only known kinds, and review stages declare approveTo", () => {
  for (const [name, stages] of [["JOB_STAGES", JOB_STAGES], ["ITEM_STAGES", ITEM_STAGES]]) {
    for (const [status, stage] of Object.entries(stages)) {
      assert.ok(STAGE_KINDS.includes(stage.kind), `${name}.${status} bad kind`);
      if (stage.kind === "review") {
        assert.ok(stage.approveTo, `${name}.${status} review stage needs approveTo`);
        assert.ok(stages[stage.approveTo], `${name}.${status}.approveTo dangles`);
      }
    }
  }
});

test("reviewStatuses names the human gate on both tables", () => {
  assert.deepEqual(reviewStatuses(ITEM_STAGES), ["awaiting_approval"]);
  assert.deepEqual(reviewStatuses(JOB_STAGES), ["awaiting_approval"]);
  assert.equal(ITEM_STAGES.awaiting_approval.reviewerKind, "human");
});

// --- transitions ------------------------------------------------------------

test("nothing escapes a terminal stage", () => {
  // R5.2.2 — approved is no longer terminal; published is the new terminal done state
  for (const terminal of ["published", "rejected"]) {
    assert.equal(isTerminal(terminal, ITEM_STAGES), true, `${terminal} must be terminal`);
    assert.equal(allowedTransitions(terminal, ITEM_STAGES).size, 0, `${terminal} must have no outgoing transitions`);
    assert.equal(isLegalTransition(terminal, "draft", ITEM_STAGES), false);
    assert.equal(isLegalTransition(terminal, "awaiting_approval", ITEM_STAGES), false);
  }
  // approved is now a working state, not terminal
  assert.equal(isTerminal("approved", ITEM_STAGES), false, "approved must no longer be terminal");
  // failed is terminal in JOB_STAGES (not in ITEM_STAGES)
  assert.equal(isTerminal("failed", JOB_STAGES), true, "failed must be terminal in JOB_STAGES");
  assert.equal(allowedTransitions("failed", JOB_STAGES).size, 0, "failed must have no outgoing transitions in JOB_STAGES");
});

test("working stages move freely between each other (pipelines are composable)", () => {
  assert.equal(isLegalTransition("coordinating", "researching"), true);
  assert.equal(isLegalTransition("researching", "drafting"), true);
  // A custom pipeline may drop research entirely — coordinate straight to draft.
  assert.equal(isLegalTransition("coordinating", "drafting"), true);
  // The revision loop re-writes the same status on each cycle.
  assert.equal(isLegalTransition("drafting", "drafting"), true);
  assert.equal(isLegalTransition("reviewing", "drafting"), true);
});

test("failure can interrupt any non-terminal stage", () => {
  for (const status of ["pending", "coordinating", "drafting", "reviewing", "awaiting_approval"]) {
    assert.equal(isLegalTransition(status, "failed"), true, `${status} → failed must be legal`);
  }
});

test("a review stage exits ONLY through its declared decision routes", () => {
  const allowed = allowedTransitions("awaiting_approval");
  assert.equal(allowed.has("approved"), true);
  assert.equal(allowed.has("rejected"), true);
  assert.equal(allowed.has("awaiting_approval"), true); // requestChangesTo, self
  assert.equal(allowed.has("drafting"), false, "the gate must not silently reopen drafting");
  assert.equal(allowed.has("researching"), false);
});

test("the first write on a fresh row is always legal; an unknown target never is", () => {
  assert.equal(isLegalTransition(null, "pending"), true);
  assert.equal(isLegalTransition(undefined, "coordinating"), true);
  assert.equal(isLegalTransition("drafting", "not_a_status"), false);
  assert.equal(isLegalTransition("not_a_status", "drafting"), false);
});

// --- decisions --------------------------------------------------------------

test("normalizeDecision accepts both the wire verdicts and paperclip's vocabulary", () => {
  assert.equal(normalizeDecision("approved"), "approve");
  assert.equal(normalizeDecision("approve"), "approve");
  assert.equal(normalizeDecision("changes_requested"), "request_changes");
  assert.equal(normalizeDecision("request_changes"), "request_changes");
  assert.equal(normalizeDecision("rejected"), "reject");
  assert.equal(normalizeDecision("nonsense"), null);
});

test("decideItemStatus routes each verdict to its declared target", () => {
  assert.deepEqual(decideItemStatus("awaiting_approval", "approved"), {
    ok: true,
    status: "approved",
    decision: "approve",
  });
  assert.deepEqual(decideItemStatus("awaiting_approval", "rejected"), {
    ok: true,
    status: "rejected",
    decision: "reject",
  });
  assert.deepEqual(decideItemStatus("awaiting_approval", "changes_requested"), {
    ok: true,
    status: "changes_requested",
    decision: "request_changes",
  });
});

test("decideItemStatus refuses a decision against a non-review stage", () => {
  for (const status of ["draft", "approved", "rejected", "changes_requested"]) {
    const r = decideItemStatus(status, "approved");
    assert.equal(r.ok, false, `"${status}" must not accept a decision`);
    assert.equal(r.code, "not_a_review_stage");
    assert.match(r.error, /awaiting_approval/);
  }
});

test("decideItemStatus separates a bad verdict (400) from a bad stage (409)", () => {
  assert.equal(decideItemStatus("awaiting_approval", "maybe").code, "bad_verdict");
  assert.equal(decideItemStatus("who_knows", "approved").code, "unknown_stage");
});

// --- job/item mirror --------------------------------------------------------

test("jobStatusForItemStatus keeps the job at its gate while a revision is in flight", () => {
  assert.equal(jobStatusForItemStatus("changes_requested"), "awaiting_approval");
  assert.equal(jobStatusForItemStatus("approved"), "approved");
  assert.equal(jobStatusForItemStatus("rejected"), "rejected");
});

test("jobStatusForItemStatus never invents a job status the worker cannot produce", () => {
  // "draft" is an ITEM status only — mirroring it onto the job would write a
  // status no JOB_STAGES entry defines, which is the D5 bug.
  assert.equal(jobStatusForItemStatus("draft"), "awaiting_approval");
  assert.ok(JOB_STAGES[jobStatusForItemStatus("draft")]);
  for (const itemStatus of Object.keys(ITEM_STAGES)) {
    assert.ok(
      JOB_STAGES[jobStatusForItemStatus(itemStatus)],
      `item status "${itemStatus}" mirrored to an unknown job status`
    );
  }
});
