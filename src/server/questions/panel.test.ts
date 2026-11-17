import test from "node:test";
import assert from "node:assert/strict";
import {
  PANEL_ORIGIN_BY_QUESTION_ORIGIN,
  buildPanelInput,
  diffAgainstApproved,
  nearDuplicatePairs,
  approveQuestionPanel,
  type PanelArtifact,
} from "./panel.ts";
import type { QuestionSettings, WorkspaceQuestion } from "./workspaceQuestions.ts";
import { AppError } from "../../shared/http/appError.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

function makeQuestion(overrides: Partial<WorkspaceQuestion> = {}): WorkspaceQuestion {
  return {
    id: "q-1",
    brandKey: "test.com",
    text: "Which running shoes are best for flat feet?",
    textNormalized: "which running shoes are best for flat feet?",
    topic: "Footwear",
    origin: "manual",
    status: "active",
    branded: false,
    cohort: "core",
    replacedBy: null,
    duplicateReason: null,
    sourceRef: null,
    createdBy: "user-1",
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<QuestionSettings> = {}): QuestionSettings {
  return {
    brandKey: "test.com",
    revision: 1,
    persona: "Runners in India",
    country: "in",
    language: "en",
    researchKeywords: ["running shoes"],
    setupJobId: null,
    setupSavedJobId: null,
    setupSavedAt: null,
    backfilledAt: null,
    ...overrides,
  };
}

test("buildPanelInput filters to active-only and sorts by topic (General last), createdAt, id", () => {
  const settings = makeSettings();
  const questions: WorkspaceQuestion[] = [
    makeQuestion({
      id: "q-gen",
      topic: "General",
      text: "How to choose shoes?",
      createdAt: "2026-10-21T10:00:00.000Z",
    }),
    makeQuestion({
      id: "q-archived",
      topic: "Apparel",
      status: "archived",
      text: "Archived question text",
    }),
    makeQuestion({
      id: "q-paused",
      topic: "Apparel",
      status: "paused",
      text: "Paused question text",
    }),
    makeQuestion({
      id: "q-b2",
      topic: "Apparel",
      text: "Which socks are best for marathons?",
      createdAt: "2026-10-21T11:00:00.000Z",
    }),
    makeQuestion({
      id: "q-b1",
      topic: "Apparel",
      text: "Which shorts are best for marathons?",
      createdAt: "2026-10-21T10:30:00.000Z",
    }),
    makeQuestion({
      id: "q-c",
      topic: "Footwear",
      text: "Which running shoes are best?",
      createdAt: "2026-10-21T10:00:00.000Z",
    }),
  ];

  const panel = buildPanelInput(settings, questions, 5);

  assert.equal(panel.persona, "Runners in India");
  assert.equal(panel.workspace_revision, 5);
  assert.equal(panel.prompts.length, 4);

  // Expected order: Apparel (q-b1, q-b2), Footwear (q-c), General (q-gen)
  assert.deepEqual(
    panel.prompts.map((p) => p.id),
    ["q-b1", "q-b2", "q-c", "q-gen"]
  );
  assert.equal(panel.prompts[3].topic, "General");
});

test("buildPanelInput maps question_id, cohort, workspace_origin, and origin", () => {
  const settings = makeSettings();
  const q1 = makeQuestion({
    id: "q-1",
    origin: "ai_setup",
    branded: true,
  });
  const q2 = makeQuestion({
    id: "q-2",
    origin: "prompt_research",
    branded: false,
    duplicateReason: "distinct buyer persona",
  });
  const q3 = makeQuestion({
    id: "q-3",
    origin: "import",
    sourceRef: { panel_origin: "licensed_panel" },
  });

  const panel = buildPanelInput(settings, [q1, q2, q3], 1);
  assert.equal(panel.prompts[0].question_id, "q-1");
  assert.equal(panel.prompts[0].cohort, "core");
  assert.equal(panel.prompts[0].weight, 1);
  assert.equal(panel.prompts[0].workspace_origin, "ai_setup");
  assert.equal(panel.prompts[0].origin, "generated");
  assert.equal(panel.prompts[0].purpose, "diagnostic");

  assert.equal(panel.prompts[1].workspace_origin, "prompt_research");
  assert.equal(panel.prompts[1].origin, "search_questions");
  assert.equal(panel.prompts[1].purpose, undefined);
  assert.equal(panel.prompts[1].duplicate_reason, "distinct buyer persona");

  assert.equal(panel.prompts[2].workspace_origin, "import");
  assert.equal(panel.prompts[2].origin, "licensed_panel");
});

test("diffAgainstApproved calculates added, removed, contextChanged and dirty", () => {
  const settings = makeSettings({ persona: "Runners in India", country: "in", language: "en" });
  const q1 = makeQuestion({ id: "q-1", text: "Question 1", textNormalized: "question 1" });
  const q2 = makeQuestion({ id: "q-2", text: "Question 2", textNormalized: "question 2" });
  const q3 = makeQuestion({ id: "q-3", text: "Question 3", textNormalized: "question 3" });

  // 1. No approved panel
  const diffNone = diffAgainstApproved(null, [q1, q2], settings);
  assert.equal(diffNone.approvedVersion, null);
  assert.equal(diffNone.added, 2);
  assert.equal(diffNone.removed, 0);
  assert.equal(diffNone.contextChanged, false);
  assert.equal(diffNone.dirty, true);

  // 2. Approved panel exists with q1 and q2, identical context
  const approved: PanelArtifact = {
    version: 2,
    payload: {
      persona: "Runners in India",
      context: { country: "in", language: "en" },
      prompts: [
        { text: "Question 1" },
        { text: "Question 2" },
      ],
    },
  };
  const diffSame = diffAgainstApproved(approved, [q1, q2], settings);
  assert.equal(diffSame.approvedVersion, 2);
  assert.equal(diffSame.added, 0);
  assert.equal(diffSame.removed, 0);
  assert.equal(diffSame.contextChanged, false);
  assert.equal(diffSame.dirty, false);

  // 3. One question added, one removed
  const diffChanged = diffAgainstApproved(approved, [q1, q3], settings);
  assert.equal(diffChanged.added, 1);
  assert.equal(diffChanged.removed, 1);
  assert.equal(diffChanged.dirty, true);

  // 4. Context changed
  const diffContext = diffAgainstApproved(
    approved,
    [q1, q2],
    makeSettings({ persona: "Different persona", country: "in", language: "en" })
  );
  assert.equal(diffContext.added, 0);
  assert.equal(diffContext.removed, 0);
  assert.equal(diffContext.contextChanged, true);
  assert.equal(diffContext.dirty, true);
});

test("nearDuplicatePairs detects overlapping pairs and respects duplicate_reason", () => {
  const q1 = makeQuestion({
    id: "q-1",
    text: "Which running shoes are best for marathon training?",
  });
  const q2 = makeQuestion({
    id: "q-2",
    text: "Which running shoes are best for marathon training daily?",
  });

  const pairs = nearDuplicatePairs([q1, q2], []);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].leftId, "q-1");
  assert.equal(pairs[0].rightId, "q-2");
  assert.ok(pairs[0].similarity > 0.8);

  // When q2 has duplicateReason, the pair is cleared by validatePanel
  const q2WithReason = makeQuestion({
    id: "q-2",
    text: "Which running shoes are best for marathon training daily?",
    duplicateReason: "daily training focus",
  });
  const pairsCleared = nearDuplicatePairs([q1, q2WithReason], []);
  assert.equal(pairsCleared.length, 0);
});

test("approveQuestionPanel validates persona, active non-branded, revision, and near duplicates", async () => {
  const mockAdmin = {
    from(table: string) {
      if (table === "workspace_question_settings") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      revision: 3,
                      persona: "Athletes",
                      country: "in",
                      language: "en",
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "workspace_questions") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return {
                      order() {
                        return {
                          order() {
                            return {
                              in: async () => ({
                                data: [
                                  {
                                    id: "11111111-1111-1111-1111-111111111111",
                                    brand_key: "test.com",
                                    text: "Which running shoes are best for marathon training?",
                                    text_normalized: "which running shoes are best for marathon training?",
                                    topic: "Shoes",
                                    origin: "manual",
                                    status: "active",
                                    branded: false,
                                    cohort: "core",
                                    replaced_by: null,
                                    duplicate_reason: null,
                                    source_ref: null,
                                    created_by: "user-1",
                                    created_at: "2026-10-21T10:00:00.000Z",
                                    updated_at: "2026-10-21T10:00:00.000Z",
                                    archived_at: null,
                                  },
                                ],
                                error: null,
                              }),
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (fn: string) => {
      if (fn === "save_workspace_questions") {
        return { data: { revision: 4 }, error: null };
      }
      throw new Error(`Unexpected rpc ${fn}`);
    },
  } as any;

  const mockWs: Workspace = {
    user: { id: "user-1", email: "runner@test.com" },
    brandKey: "test.com",
    brand: {
      brandKey: "test.com",
      role: "owner",
      display_name: "Test Runner",
      website: "https://test.com",
      website_host: "test.com",
      aliases: ["Test Runner"],
      is_active: true,
    },
    role: "owner",
    admin: mockAdmin,
  };

  let appended: any = null;
  const mockStore = () => ({
    list: async () => [{ artifact_key: "default", version: 2 }],
    append: async (arg: any) => {
      appended = arg;
      return { id: "art-3", version: 3 };
    },
  });

  // Stale revision check
  await assert.rejects(
    async () => approveQuestionPanel(mockAdmin, mockWs, 2, { repairWorkflowStore: mockStore as any }),
    (err: any) => err instanceof AppError && err.code === "revision_conflict"
  );

  // Successful approval
  const res = await approveQuestionPanel(mockAdmin, mockWs, 3, {
    repairWorkflowStore: mockStore as any,
    now: () => "2026-10-21T12:00:00.000Z",
  });

  assert.equal(res.version, 3);
  assert.equal(res.approvedAt, "2026-10-21T12:00:00.000Z");
  assert.equal(res.questionCount, 1);
  assert.equal(res.diagnosticCount, 0);
  assert.ok(appended);
  assert.equal(appended.expectedVersion, 2);
  assert.equal(appended.state, "approved");
});

test("approveQuestionPanel refuses when persona is missing or only branded questions exist", async () => {
  const emptyPersonaAdmin = {
    from(table: string) {
      if (table === "workspace_question_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { revision: 1, persona: "", country: "in", language: "en" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "workspace_questions") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({
                  order: () => ({
                    in: async () => ({
                      data: [
                        {
                          id: "11111111-1111-1111-1111-111111111111",
                          brand_key: "test.com",
                          text: "Which running shoes are best?",
                          text_normalized: "which running shoes are best?",
                          topic: "Shoes",
                          origin: "manual",
                          status: "active",
                          branded: false,
                          created_at: "2026-10-21T10:00:00.000Z",
                          updated_at: "2026-10-21T10:00:00.000Z",
                        },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as any;

  const mockWs: Workspace = {
    user: { id: "user-1", email: "u@t.com" },
    brandKey: "test.com",
    brand: {
      brandKey: "test.com",
      role: "owner",
      display_name: "Test",
      website: "https://test.com",
      website_host: "test.com",
      aliases: [],
      is_active: true,
    },
    role: "owner",
    admin: emptyPersonaAdmin,
  };

  await assert.rejects(
    async () => approveQuestionPanel(emptyPersonaAdmin, mockWs, 1),
    (err: any) => err instanceof AppError && err.code === "persona_required"
  );

  const onlyBrandedAdmin = {
    from(table: string) {
      if (table === "workspace_question_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { revision: 1, persona: "Shoppers", country: "in", language: "en" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "workspace_questions") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({
                  order: () => ({
                    in: async () => ({
                      data: [
                        {
                          id: "11111111-1111-1111-1111-111111111111",
                          brand_key: "test.com",
                          text: "Is Test good?",
                          text_normalized: "is test good?",
                          topic: "General",
                          origin: "manual",
                          status: "active",
                          branded: true,
                          created_at: "2026-10-21T10:00:00.000Z",
                          updated_at: "2026-10-21T10:00:00.000Z",
                        },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as any;

  await assert.rejects(
    async () => approveQuestionPanel(onlyBrandedAdmin, mockWs, 1),
    (err: any) => err instanceof AppError && err.code === "nothing_to_approve"
  );
});
