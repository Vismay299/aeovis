import test from "node:test";
import assert from "node:assert/strict";

const questionsRoute = await import("../../app/api/customer/questions/route.ts");
const approveRoute = await import("../../app/api/customer/questions/approve/route.ts");

const USER = { id: "user-1", email: "owner@offcult.in" };
const BRAND_KEY = "offcult.in";

function makeBrand(role = "member") {
  return {
    brandKey: BRAND_KEY,
    role,
    display_name: "Offcult",
    website: "https://offcult.in",
    website_host: "offcult.in",
    aliases: ["Offcult"],
    is_active: true,
  };
}

function makeMockAdmin({
  revision = 1,
  persona = "Indian buyers aged 18–30",
  questions = [],
  heads = [],
  saveError = null,
} = {}) {
  let currentRevision = revision;
  let backfillCalls = 0;
  let saveCalls = [];

  const admin = {
    getBackfillCalls: () => backfillCalls,
    getSaveCalls: () => saveCalls,
    from(table) {
      if (table === "workspace_question_settings") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      revision: currentRevision,
                      persona,
                      country: "in",
                      language: "en",
                      research_keywords: ["oversized tees"],
                      setup_job_id: null,
                      setup_saved_job_id: null,
                      setup_saved_at: null,
                      backfilled_at: "2026-10-21T09:00:00.000Z",
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
            let filterStatuses = null;
            const queryBuilder = {
              eq() {
                return queryBuilder;
              },
              order() {
                return queryBuilder;
              },
              in(_col, vals) {
                filterStatuses = vals;
                return queryBuilder;
              },
              then(resolve, reject) {
                const filtered = filterStatuses
                  ? questions.filter((q) => filterStatuses.includes(q.status || "active"))
                  : questions;
                const data = filtered.map((q) => ({
                  id: q.id,
                  brand_key: BRAND_KEY,
                  text: q.text,
                  text_normalized: q.text.toLowerCase(),
                  topic: q.topic || "General",
                  origin: q.origin || "manual",
                  status: q.status || "active",
                  branded: Boolean(q.branded),
                  cohort: "core",
                  replaced_by: q.replacedBy || null,
                  duplicate_reason: q.duplicateReason || null,
                  source_ref: q.sourceRef || null,
                  created_by: USER.id,
                  created_at: q.createdAt || "2026-10-21T09:00:00.000Z",
                  updated_at: q.updatedAt || "2026-10-21T09:00:00.000Z",
                  archived_at: q.archivedAt || null,
                }));
                return Promise.resolve({ data, error: null }).then(resolve, reject);
              },
            };
            return queryBuilder;
          },
        };
      }
      if (table === "repair_artifacts") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          eq() {
                            return {
                              order() {
                                return {
                                  limit() {
                                    return {
                                      maybeSingle: async () => ({ data: null, error: null }),
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
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    async rpc(name, args) {
      if (name === "backfill_workspace_questions") {
        backfillCalls++;
        return { data: { created: 0, active: 0, skipped: true }, error: null };
      }
      if (name === "save_workspace_questions") {
        saveCalls.push(args);
        if (saveError) return { data: null, error: saveError };
        if (args.p_expected_revision !== currentRevision) {
          return { data: null, error: new Error("question_revision_conflict") };
        }
        currentRevision++;
        return { data: { revision: currentRevision }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  return admin;
}

function makeDeps(over = {}) {
  const role = over.role || "owner";
  const admin = over.admin || makeMockAdmin(over);
  const ws = {
    user: USER,
    brandKey: BRAND_KEY,
    brand: makeBrand(role),
    role,
    admin,
  };
  return {
    requireWorkspace: async () => ws,
    isFeatureEnabled: over.isFeatureEnabled || (async () => true),
    repairWorkflowStore: over.repairWorkflowStore || (() => ({
      list: async () => over.heads || [],
      append: over.append || (async () => ({ id: "art-1", version: 1 })),
    })),
    getJobStatus: over.getJobStatus || (async () => ({ status: "none", progress: null, error: null })),
    admin,
  };
}

test("GET /api/customer/questions returns 404 feature_unavailable when flag is off", async () => {
  const deps = makeDeps({ isFeatureEnabled: async () => false });
  const req = new Request(`https://app.test/api/customer/questions?brand_key=${BRAND_KEY}`);
  const res = await questionsRoute.GET(req, undefined, deps);
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.code, "feature_unavailable");
});

test("GET /api/customer/questions returns state and runs lazy backfill", async () => {
  const admin = makeMockAdmin({
    questions: [
      { id: "11111111-1111-4111-8111-111111111111", text: "Which oversized tees are best?", topic: "Tees" },
    ],
  });
  const deps = makeDeps({ admin });
  const req = new Request(`https://app.test/api/customer/questions?brand_key=${BRAND_KEY}`);
  const res = await questionsRoute.GET(req, undefined, deps);
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.equal(json.brandKey, BRAND_KEY);
  assert.equal(json.revision, 1);
  assert.equal(json.questions.length, 1);
  assert.equal(json.questions[0].text, "Which oversized tees are best?");
  assert.equal(json.topics.length, 1);
  assert.equal(json.limits.unarchived, 1);
  assert.equal(admin.getBackfillCalls(), 1);
});

test("PATCH /api/customer/questions handles create/edit/archive and settings update", async () => {
  const admin = makeMockAdmin({
    revision: 5,
    questions: [
      { id: "11111111-1111-4111-8111-111111111111", text: "Original question wording", topic: "Tees" },
    ],
  });
  const deps = makeDeps({ admin });
  const req = new Request(`https://app.test/api/customer/questions`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      brand_key: BRAND_KEY,
      expectedRevision: 5,
      patch: {
        questions: [{ text: "New buyer question text", topic: "Streetwear" }],
        archiveIds: ["11111111-1111-4111-8111-111111111111"],
      },
      settings: {
        persona: "Updated persona description",
      },
    }),
  });

  const res = await questionsRoute.PATCH(req, undefined, deps);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.created, 1);
  assert.equal(json.updated, 1);
  assert.equal(json.skipped, 0);

  const calls = admin.getSaveCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p_expected_revision, 5);
  assert.equal(calls[0].p_settings.persona, "Updated persona description");
});

test("PATCH /api/customer/questions returns 409 revision_conflict on stale revision", async () => {
  const admin = makeMockAdmin({ revision: 10 });
  const deps = makeDeps({ admin });
  const req = new Request(`https://app.test/api/customer/questions`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      brand_key: BRAND_KEY,
      expectedRevision: 9, // stale!
      settings: { persona: "New persona" },
    }),
  });

  const res = await questionsRoute.PATCH(req, undefined, deps);
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.code, "revision_conflict");
});

test("POST /api/customer/questions/approve succeeds and refuses on persona, non-branded, near-duplicates, conflict", async () => {
  // 1. Refusal: persona required
  {
    const admin = makeMockAdmin({ persona: "" });
    const deps = makeDeps({ admin });
    const req = new Request(`https://app.test/api/customer/questions/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand_key: BRAND_KEY, expectedRevision: 1 }),
    });
    const res = await approveRoute.POST(req, undefined, deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.code, "persona_required");
  }

  // 2. Refusal: nothing to approve (only branded question)
  {
    const admin = makeMockAdmin({
      persona: "Shoppers",
      questions: [
        { id: "11111111-1111-4111-8111-111111111111", text: "Is Offcult good?", branded: true },
      ],
    });
    const deps = makeDeps({ admin });
    const req = new Request(`https://app.test/api/customer/questions/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand_key: BRAND_KEY, expectedRevision: 1 }),
    });
    const res = await approveRoute.POST(req, undefined, deps);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, "nothing_to_approve");
  }

  // 3. Refusal: near duplicates without reason
  {
    const admin = makeMockAdmin({
      persona: "Shoppers",
      questions: [
        { id: "11111111-1111-4111-8111-111111111111", text: "Which running shoes are best for marathon training daily?" },
        { id: "22222222-2222-4222-8222-222222222222", text: "Which running shoes are best for marathon training?" },
      ],
    });
    const deps = makeDeps({ admin });
    const req = new Request(`https://app.test/api/customer/questions/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand_key: BRAND_KEY, expectedRevision: 1 }),
    });
    const res = await approveRoute.POST(req, undefined, deps);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, "near_duplicates");
    assert.ok(json.details.pairs.length > 0);
  }

  // 4. Refusal: stale revision
  {
    const admin = makeMockAdmin({
      persona: "Shoppers",
      revision: 2,
      questions: [
        { id: "11111111-1111-4111-8111-111111111111", text: "Which running shoes are best?" },
      ],
    });
    const deps = makeDeps({ admin });
    const req = new Request(`https://app.test/api/customer/questions/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand_key: BRAND_KEY, expectedRevision: 1 }),
    });
    const res = await approveRoute.POST(req, undefined, deps);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, "revision_conflict");
  }

  // 5. Success
  {
    const admin = makeMockAdmin({
      persona: "Shoppers in India",
      revision: 2,
      questions: [
        { id: "11111111-1111-4111-8111-111111111111", text: "Which running shoes are best in India?" },
      ],
    });
    let appendedArtifact = null;
    const deps = makeDeps({
      admin,
      repairWorkflowStore: () => ({
        list: async () => [{ artifact_key: "default", version: 1 }],
        append: async (arg) => {
          appendedArtifact = arg;
          return { id: "art-2", version: 2 };
        },
      }),
    });

    const req = new Request(`https://app.test/api/customer/questions/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand_key: BRAND_KEY, expectedRevision: 2 }),
    });
    const res = await approveRoute.POST(req, undefined, deps);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.panel.version, 2);
    assert.equal(json.panel.questionCount, 1);
    assert.ok(json.state);
    assert.ok(appendedArtifact);
    assert.equal(appendedArtifact.expectedVersion, 1);
  }
});
