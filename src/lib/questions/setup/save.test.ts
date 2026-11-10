import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { saveSetupReview } from "./save.ts";
import { AppError } from "../../http/appError.ts";
import type { Workspace } from "../../workspace/requireWorkspace.ts";

describe("saveSetupReview (F08-AC-16)", () => {
  const dummyWorkspace: Workspace = {
    brandKey: "offcult.in",
    user: { id: "00000000-0000-0000-0000-000000000001", email: "user@example.com" },
    role: "owner",
    admin: {} as any,
    brand: {
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: ["Offcult"],
      brandKey: "offcult.in",
      role: "owner",
      is_active: true,
    },
  };

  const sampleReview = {
    version: 1,
    overview: {
      text: "Draft overview",
      preserved: false,
    },
    persona: "Indian shoppers",
    competitors: {
      preserved: false,
      items: [
        {
          name: "Bewakoof",
          domain: "bewakoof.com",
          notes: "Competitor",
          sourceUrl: "https://bewakoof.com/oversized",
        },
      ],
    },
    candidates: [
      {
        id: "c1",
        text: "What are the best streetwear tees in India?",
        topic: "Streetwear",
        origin: "ai_setup" as const,
        branded: false,
        eliciting: true,
        selected: true,
        existing: null,
      },
      {
        id: "c2",
        text: "Where to buy oversized anime graphic tees?",
        topic: "Anime Tees",
        origin: "promptgen" as const,
        branded: false,
        eliciting: true,
        selected: true,
        existing: null,
      },
    ],
    topics: ["Streetwear", "Anime Tees"],
    suggestedKeywords: ["oversized tees"],
    warnings: [],
  };

  function createMockStore(jobOverride: any = {}) {
    return {
      get: async (id: string) => ({
        id,
        brand_key: "offcult.in",
        kind: "questions.setup",
        status: "completed",
        result: { review: sampleReview },
        ...jobOverride,
      }),
    } as any;
  }

  function createMockAdmin(settingsOverride: any = {}) {
    const admin: any = {
      from(table: string) {
        return {
          select() {
            const chain: any = {
              eq() {
                return chain;
              },
              in() {
                return chain;
              },
              order() {
                return chain;
              },
              data: [],
              error: null,
              async maybeSingle() {
                if (table === "workspace_question_settings") {
                  return {
                    data: {
                      brand_key: "offcult.in",
                      revision: 0,
                      persona: null,
                      country: "in",
                      language: "en",
                      research_keywords: [],
                      setup_job_id: "00000000-0000-0000-0000-000000000010",
                      setup_saved_job_id: null,
                      ...settingsOverride,
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
              then(resolve: any) {
                return Promise.resolve({ data: [], error: null }).then(resolve);
              },
            };
            return chain;
          },
        };
      },
      rpc(fn: string) {
        if (fn === "save_workspace_questions") {
          return Promise.resolve({ data: { revision: 1 }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return admin;
  }

  it("saves review, applies context ops, patches questions, and returns state", async () => {
    const admin = createMockAdmin();
    const store = createMockStore();
    let appliedOps: any[] = [];
    const mockRepo: any = {
      applyOps: async (_brand: string, ops: any[]) => {
        appliedOps = ops;
      },
    };

    const mockState = {
      brandKey: "offcult.in",
      revision: 1,
    } as any;

    const res = await saveSetupReview(
      admin,
      dummyWorkspace,
      {
        jobId: "00000000-0000-0000-0000-000000000010",
        expectedRevision: 0,
        overview: "My business sells streetwear.",
        competitors: [
          { name: "Bewakoof", domain: "bewakoof.com", notes: "Top rival" },
        ],
        selectedCandidateIds: ["c1", "c2"],
        persona: "Young Indian shoppers",
        country: "in",
        language: "en",
        approve: false,
      },
      {
        store,
        repo: mockRepo,
        getQuestionsState: async () => mockState,
      },
    );

    assert.strictEqual(res.saved.overviewSaved, true);
    assert.strictEqual(res.saved.competitorsSaved, 1);
    assert.strictEqual(res.saved.questionsAdded, 2);
    assert.strictEqual(res.panel, null);
    assert.deepStrictEqual(res.state, mockState);

    // Verify context ops
    assert.strictEqual(appliedOps.length, 2);
    assert.strictEqual(appliedOps[0].kind, "insert_section_if_missing");
    assert.strictEqual(appliedOps[1].kind, "insert_competitors_if_none");
    assert.strictEqual(appliedOps[1].rows[0].source, "setup_research");
    assert.strictEqual(appliedOps[1].rows[0].source_url, "https://bewakoof.com/oversized");
  });

  it("handles approve = true and captures approval result", async () => {
    const admin = createMockAdmin();
    const store = createMockStore();
    const mockRepo: any = { applyOps: async () => {} };

    const mockPanel = {
      version: 1,
      approvedAt: "2026-11-10T12:00:00Z",
      questionCount: 2,
      diagnosticCount: 0,
      summary: {},
    };

    const res = await saveSetupReview(
      admin,
      dummyWorkspace,
      {
        jobId: "00000000-0000-0000-0000-000000000010",
        expectedRevision: 0,
        competitors: [],
        selectedCandidateIds: ["c1"],
        persona: "Audience",
        country: "in",
        language: "en",
        approve: true,
      },
      {
        store,
        repo: mockRepo,
        approveQuestionPanel: async () => mockPanel,
        getQuestionsState: async () => ({ brandKey: "offcult.in", revision: 2 } as any),
      },
    );

    assert.deepStrictEqual(res.panel, mockPanel);
    assert.strictEqual(res.approveError, undefined);
  });

  it("captures approveError when approval is refused without failing the save", async () => {
    const admin = createMockAdmin();
    const store = createMockStore();
    const mockRepo: any = { applyOps: async () => {} };

    const res = await saveSetupReview(
      admin,
      dummyWorkspace,
      {
        jobId: "00000000-0000-0000-0000-000000000010",
        expectedRevision: 0,
        competitors: [],
        selectedCandidateIds: ["c1"],
        persona: "Audience",
        country: "in",
        language: "en",
        approve: true,
      },
      {
        store,
        repo: mockRepo,
        approveQuestionPanel: async () => {
          throw new AppError(409, "near_duplicates", "Questions look alike.");
        },
        getQuestionsState: async () => ({ brandKey: "offcult.in", revision: 1 } as any),
      },
    );

    assert.strictEqual(res.panel, null);
    assert.deepStrictEqual(res.approveError, {
      code: "near_duplicates",
      message: "Questions look alike.",
    });
  });

  it("rejects when own website is declared as competitor", async () => {
    const admin = createMockAdmin();
    const store = createMockStore();

    await assert.rejects(
      async () => {
        await saveSetupReview(
          admin,
          dummyWorkspace,
          {
            jobId: "00000000-0000-0000-0000-000000000010",
            expectedRevision: 0,
            competitors: [{ name: "Self", domain: "offcult.in", notes: "" }],
            selectedCandidateIds: [],
            persona: "Audience",
            country: "in",
            language: "en",
            approve: false,
          },
          { store },
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "context_invalid");
        assert.strictEqual(err.status, 400);
        return true;
      },
    );
  });

  it("does not save setup competitors when F07 already had competitors", async () => {
    const admin = createMockAdmin();
    const store = createMockStore({
      result: {
        review: {
          ...sampleReview,
          competitors: { ...sampleReview.competitors, preserved: true },
        },
      },
    });
    let appliedOps: any[] = [];

    await saveSetupReview(
      admin,
      dummyWorkspace,
      {
        jobId: "00000000-0000-0000-0000-000000000010",
        expectedRevision: 0,
        competitors: [{ name: "Bewakoof", domain: "bewakoof.com", notes: "" }],
        selectedCandidateIds: [],
        persona: "Audience",
        country: "in",
        language: "en",
        approve: false,
      },
      {
        store,
        repo: {
          applyOps: async (_brand: string, ops: any[]) => {
            appliedOps = ops;
          },
        } as any,
        getQuestionsState: async () => ({ brandKey: "offcult.in", revision: 1 } as any),
      },
    );

    assert.deepStrictEqual(appliedOps, []);
  });

  it("rejects when setup research was already saved", async () => {
    const admin = createMockAdmin({
      setup_saved_job_id: "00000000-0000-0000-0000-000000000010",
    });
    const store = createMockStore();

    await assert.rejects(
      async () => {
        await saveSetupReview(
          admin,
          dummyWorkspace,
          {
            jobId: "00000000-0000-0000-0000-000000000010",
            expectedRevision: 0,
            competitors: [],
            selectedCandidateIds: [],
            persona: "Audience",
            country: "in",
            language: "en",
            approve: false,
          },
          { store },
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.code, "setup_already_saved");
        assert.strictEqual(err.status, 409);
        return true;
      },
    );
  });
});
