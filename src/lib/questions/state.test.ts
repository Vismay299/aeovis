import test from "node:test";
import assert from "node:assert/strict";
import { getQuestionsState } from "./state.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

test("getQuestionsState calls backfill and assembles state with topics, limits, and setup status", async () => {
  let backfilled = false;

  const mockAdmin = {
    from(table: string) {
      if (table === "workspace_question_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  revision: 4,
                  persona: "Streetwear buyers in India",
                  country: "in",
                  language: "en",
                  research_keywords: ["oversized tees"],
                  setup_job_id: "job-123",
                  setup_saved_job_id: null,
                },
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
                  order: async () => ({
                    data: [
                      {
                        id: "q-1",
                        brand_key: "offcult.in",
                        text: "Where to buy oversized tees in India?",
                        text_normalized: "where to buy oversized tees in india?",
                        topic: "Oversized tees",
                        origin: "ai_setup",
                        status: "active",
                        branded: false,
                        cohort: "core",
                        replaced_by: null,
                        duplicate_reason: null,
                        source_ref: null,
                        created_by: "u-1",
                        created_at: "2026-10-21T09:00:00.000Z",
                        updated_at: "2026-10-21T09:00:00.000Z",
                        archived_at: null,
                      },
                      {
                        id: "q-2",
                        brand_key: "offcult.in",
                        text: "How to style oversized tees?",
                        text_normalized: "how to style oversized tees?",
                        topic: "Oversized tees",
                        origin: "ai_setup",
                        status: "paused",
                        branded: false,
                        cohort: "core",
                        replaced_by: null,
                        duplicate_reason: null,
                        source_ref: null,
                        created_by: "u-1",
                        created_at: "2026-10-21T09:05:00.000Z",
                        updated_at: "2026-10-21T09:05:00.000Z",
                        archived_at: null,
                      },
                      {
                        id: "q-3",
                        brand_key: "offcult.in",
                        text: "Old question text",
                        text_normalized: "old question text",
                        topic: "Archived topic",
                        origin: "manual",
                        status: "archived",
                        branded: false,
                        cohort: "core",
                        replaced_by: null,
                        duplicate_reason: null,
                        source_ref: null,
                        created_by: "u-1",
                        created_at: "2026-10-21T08:00:00.000Z",
                        updated_at: "2026-10-21T08:00:00.000Z",
                        archived_at: "2026-10-21T09:10:00.000Z",
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "repair_artifacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({
                          data: null,
                          error: null,
                        }),
                      }),
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
    user: { id: "u-1", email: "test@offcult.in" },
    brandKey: "offcult.in",
    brand: {
      brandKey: "offcult.in",
      role: "owner",
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: ["Offcult"],
      is_active: true,
    },
    role: "owner",
    admin: mockAdmin,
  };

  const state = await getQuestionsState(mockAdmin, mockWs, {
    ensureBackfilled: async () => {
      backfilled = true;
    },
    repairWorkflowStore: (() => ({
      list: async () => [
        {
          artifact_key: "default",
          version: 2,
          state: "approved",
          created_at: "2026-10-20T10:00:00.000Z",
          payload: {
            persona: "Streetwear buyers in India",
            reviewed_at: "2026-10-20T10:00:00.000Z",
            prompts: [
              {
                id: "q-1",
                question_id: "q-1",
                text: "Where to buy oversized tees in India?",
                purpose: "recommendation",
              },
            ],
          },
        },
      ],
    })) as any,
    getJobStatus: async () => ({
      status: "completed",
      progress: null,
      pollAfterSeconds: null,
      result: {},
      error: null,
    }),
  });

  assert.equal(backfilled, true);
  assert.equal(state.brandKey, "offcult.in");
  assert.equal(state.revision, 4);
  assert.equal(state.settings.persona, "Streetwear buyers in India");
  assert.equal(state.questions.length, 3);

  // Topics: unarchived only (Archived topic not included)
  assert.equal(state.topics.length, 1);
  assert.deepEqual(state.topics[0], {
    name: "Oversized tees",
    active: 1,
    paused: 1,
  });

  // Approved
  assert.ok(state.approved);
  assert.equal(state.approved.version, 2);
  assert.equal(state.approved.questionCount, 1);
  assert.equal(state.approved.carriesQuestionIds, true);

  // Limits
  assert.deepEqual(state.limits, {
    unarchived: 2,
    maxUnarchived: 100,
    topics: 1,
    maxTopics: 30,
  });

  // Setup status: completed job without setup_saved_job_id → "review"
  assert.deepEqual(state.setup, {
    status: "review",
    jobId: "job-123",
    failure: null,
  });
});

test("getQuestionsState maps setup status for saved and failed jobs", async () => {
  const mockAdmin = {
    from(table: string) {
      if (table === "workspace_question_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  revision: 1,
                  persona: "Shoppers",
                  country: "in",
                  language: "en",
                  setup_job_id: "job-fail",
                  setup_saved_job_id: null,
                },
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
                  order: async () => ({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "repair_artifacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({ data: null, error: null }),
                      }),
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
    user: { id: "u-1", email: "test@offcult.in" },
    brandKey: "offcult.in",
    brand: {
      brandKey: "offcult.in",
      role: "owner",
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: [],
      is_active: true,
    },
    role: "owner",
    admin: mockAdmin,
  };

  const failedState = await getQuestionsState(mockAdmin, mockWs, {
    ensureBackfilled: async () => {},
    repairWorkflowStore: (() => ({ list: async () => [] })) as any,
    getJobStatus: async () => ({
      status: "failed",
      progress: null,
      pollAfterSeconds: null,
      result: null,
      error: { code: "website_unreadable", message: "Site blocked" },
    }),
  });

  assert.deepEqual(failedState.setup, {
    status: "failed",
    jobId: "job-fail",
    failure: "website_unreadable",
  });
});
