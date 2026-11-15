// Portions ported from upstream (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/dashboard/dashboardSteps.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SETUP_STEPS,
  getSetupStepStatus,
  visibleSetupSteps,
  type SetupActivation,
  type SetupStep,
} from "./setup-steps.ts";

const fresh: SetupActivation = {
  completed: {
    questions: false,
    scan: false,
    gsc: false,
    audit: false,
    schedule: false,
    ga4: false,
    draft: false,
    team: false,
  },
  dismissed: [],
};

test("F27-AC-15 does not count skipped steps as completed", () => {
  assert.equal(
    getSetupStepStatus({ ...fresh, dismissed: ["scan"] }, "scan"),
    "skipped"
  );
  assert.equal(
    getSetupStepStatus({ ...fresh, dismissed: ["team"] }, "team"),
    "skipped"
  );
});

test("F27-AC-15 recognizes setup completed elsewhere even after skipping it", () => {
  const complete: SetupActivation = {
    completed: {
      questions: true,
      scan: true,
      gsc: true,
      audit: true,
      schedule: true,
      ga4: true,
      draft: true,
      team: true,
    },
    dismissed: SETUP_STEPS.map((s) => s.id),
  };

  assert.ok(
    SETUP_STEPS.every((step) => getSetupStepStatus(complete, step.id) === "done")
  );
});

test("F27-AC-15 returns todo for uncompleted and un-dismissed step", () => {
  assert.equal(getSetupStepStatus(fresh, "questions"), "todo");
});

test("F27-AC-15 visibleSetupSteps filters by flag and role", () => {
  // Owner with all flags on
  const allOn = { site_audit: true, customer_scheduling: true, ga4: true };
  assert.deepEqual(visibleSetupSteps(allOn, "owner"), [
    "questions",
    "scan",
    "gsc",
    "audit",
    "schedule",
    "ga4",
    "draft",
    "team",
  ]);

  // Member with all flags on: team is omitted because it is ownerOnly
  assert.deepEqual(visibleSetupSteps(allOn, "member"), [
    "questions",
    "scan",
    "gsc",
    "audit",
    "schedule",
    "ga4",
    "draft",
  ]);

  // Owner with all flags off: audit, schedule, ga4 are omitted
  const allOff = { site_audit: false, customer_scheduling: false, ga4: false };
  assert.deepEqual(visibleSetupSteps(allOff, "owner"), [
    "questions",
    "scan",
    "gsc",
    "draft",
    "team",
  ]);

  // Member with flags off
  assert.deepEqual(visibleSetupSteps(allOff, "member"), [
    "questions",
    "scan",
    "gsc",
    "draft",
  ]);
});
