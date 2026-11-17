import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/http/appError.ts";
import { invalidateFeatureFlagCache, isFeatureEnabled } from "../features/flags.ts";
import { POST as setupPost } from "../../app/api/customer/questions/setup/route.ts";
import { POST as savePost } from "../../app/api/customer/questions/setup/save/route.ts";
import { POST as generatePost } from "../../app/api/customer/questions/generate/route.ts";
import { POST as researchPost } from "../../app/api/customer/questions/research/route.ts";
import { GET as keywordsGet } from "../../app/api/customer/questions/research/keywords/route.ts";

const dummyWorkspace = {
  brandKey: "offcult.in",
  user: { id: "00000000-0000-0000-0000-000000000001", email: "user@example.com" },
  role: "owner",
  brand: {
    brandKey: "offcult.in",
    role: "owner",
    display_name: "Offcult",
    website: "https://offcult.in",
    website_host: "offcult.in",
    aliases: ["Offcult"],
    is_active: true,
  },
  admin: {},
};

const setupRequest = (body = {}) => new Request("https://app.test/api/customer/questions/setup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const saveRequest = (body = {}) => new Request("https://app.test/api/customer/questions/setup/save", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jobId: "a0000000-0000-4000-8000-000000000002",
    expectedRevision: 0,
    competitors: [],
    selectedCandidateIds: [],
    persona: "Young shoppers",
    country: "in",
    language: "en",
    approve: false,
    ...body,
  }),
});
const generateRequest = (body = {}) => new Request("https://app.test/api/customer/questions/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    requestId: "a0000000-0000-4000-8000-000000000001",
    topic: "Streetwear",
    ...body,
  }),
});
const researchRequest = (body = {}) => new Request("https://app.test/api/customer/questions/research", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    requestId: "a0000000-0000-4000-8000-000000000001",
    keyword: "oversized t-shirts",
    ...body,
  }),
});
const approvedPrice = async (_key, _ctx, _input, maxUsd) => ({
  quote: { totalUsd: 0.05, priceVersion: 1 },
  approvedMaxUsd: maxUsd ?? 0.1,
  source: maxUsd === undefined ? "implicit" : "dialog",
});
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
}

test("setup route gates flags, requires approval, and starts a priced job", async () => {
  const gated = await setupPost(setupRequest(), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async (name) => name === "question_curation",
    env: { NODE_ENV: "production", FEATURE_QUESTION_SETUP: "off" },
  });
  await expectError(gated, 404, "feature_unavailable");

  const approvalRequired = await setupPost(setupRequest(), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => true,
    requireApprovedPrice: async () => {
      throw new AppError(400, "approval_required", "Review and approve the price before running this.");
    },
  });
  await expectError(approvalRequired, 400, "approval_required");

  for (const [code, status] of [["price_changed", 409], ["setup_running", 409], ["question_limit", 409]]) {
    const refused = await setupPost(setupRequest(), {}, {
      requireWorkspace: async () => dummyWorkspace,
      isFeatureEnabled: async () => true,
      requireApprovedPrice: async () => {
        throw new AppError(status, code, "Setup cannot start.");
      },
    });
    await expectError(refused, status, code);
  }

  const res = await setupPost(setupRequest({ maxUsd: 1 }), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => true,
    requireApprovedPrice: approvedPrice,
    readQuestionSettings: async () => ({ country: "in", language: "en" }),
    enqueueJob: async (_kind, payload, opts) => {
      assert.equal(payload.approvedMaxUsd, 1);
      assert.equal(opts.singleActiveKey, "questions.setup:offcult.in");
      return { jobId: "a0000000-0000-4000-8000-000000000002" };
    },
    recordApproval: async () => "approval-id",
    saveSetupJob: async () => {},
  });
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.equal(data.jobId, "a0000000-0000-4000-8000-000000000002");
  assert.equal(data.status, "queued");
  assert.equal(data.pollAfterSeconds, 3);
});

test("setup save is gated and reports already-saved jobs", async () => {
  const gated = await savePost(saveRequest(), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => false,
  });
  await expectError(gated, 404, "feature_unavailable");

  const saved = await savePost(saveRequest({ overview: "Streetwear brand" }), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => true,
    saveSetupReview: async () => ({
      saved: { questionsAdded: 1, revived: 0, competitorsSaved: 0, overviewSaved: true },
      panel: null,
      state: { brandKey: "offcult.in", revision: 1 },
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).saved.overviewSaved, true);

  const duplicate = await savePost(saveRequest(), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => true,
    saveSetupReview: async () => {
      throw new AppError(409, "setup_already_saved", "This setup was already saved.");
    },
  });
  await expectError(duplicate, 409, "setup_already_saved");
});

test("generate gates flags, forwards the approved ceiling, and maps provider refusals", async () => {
  const gated = await generatePost(generateRequest(), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async (name) => name === "question_curation",
    env: { NODE_ENV: "production", FEATURE_QUESTION_SETUP: "off" },
  });
  await expectError(gated, 404, "feature_unavailable");

  let approvedInput;
  const success = await generatePost(generateRequest({ maxUsd: 0.1 }), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => true,
    requireApprovedPrice: async (...args) => {
      assert.equal(args[0], "questions.generate.run");
      return { quote: { totalUsd: 0.05 }, approvedMaxUsd: 0.1, source: "dialog" };
    },
    generateQuestions: async (_admin, _ws, input) => {
      approvedInput = input;
      return { topic: "Streetwear", questions: ["Question 1", "Question 2"] };
    },
  });
  assert.equal(success.status, 200);
  assert.equal(approvedInput.maxUsd, 0.1);
  assert.equal((await success.json()).questions.length, 2);

  for (const [code, status] of [["price_changed", 409], ["duplicate_paid_call", 409], ["feature_disabled", 403], ["daily_cap", 402], ["workspace_cap", 402]]) {
    const refused = await generatePost(generateRequest(), {}, {
      requireWorkspace: async () => dummyWorkspace,
      isFeatureEnabled: async () => true,
      requireApprovedPrice: approvedPrice,
      generateQuestions: async () => {
        throw new AppError(status, code, "The request was refused.");
      },
    });
    await expectError(refused, status, code);
  }
});

test("research gates flags, forwards the approved ceiling, and maps provider refusals", async () => {
  const gated = await researchPost(researchRequest(), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async (name) => name === "question_curation",
    env: { NODE_ENV: "production", FEATURE_PROMPT_RESEARCH: "off" },
  });
  await expectError(gated, 404, "feature_unavailable");

  let approvedInput;
  const success = await researchPost(researchRequest({ maxUsd: 0.2 }), {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => true,
    requireApprovedPrice: async (...args) => {
      assert.equal(args[0], "questions.research.run");
      return { quote: { totalUsd: 0.15 }, approvedMaxUsd: 0.2, source: "dialog" };
    },
    researchQuestions: async (_admin, _ws, input) => {
      approvedInput = input;
      return { keyword: input.keyword, questions: [], recent: null, dataset: "us-en" };
    },
  });
  assert.equal(success.status, 200);
  assert.equal(approvedInput.maxUsd, 0.2);
  assert.equal((await success.json()).dataset, "us-en");

  for (const [code, status] of [["price_changed", 409], ["duplicate_paid_call", 409], ["feature_disabled", 403], ["daily_cap", 402], ["workspace_cap", 402]]) {
    const refused = await researchPost(researchRequest(), {}, {
      requireWorkspace: async () => dummyWorkspace,
      isFeatureEnabled: async () => true,
      requireApprovedPrice: approvedPrice,
      researchQuestions: async () => {
        throw new AppError(status, code, "The request was refused.");
      },
    });
    await expectError(refused, status, code);
  }
});

test("research keyword route validates query flags and returns keywords", async () => {
  const gated = await keywordsGet(
    new Request("https://app.test/api/customer/questions/research/keywords?brand_key=offcult.in"),
    {},
    {
      requireWorkspace: async () => dummyWorkspace,
      isFeatureEnabled: async (name) => name === "question_curation",
      env: { NODE_ENV: "production", FEATURE_PROMPT_RESEARCH: "off" },
    },
  );
  await expectError(gated, 404, "feature_unavailable");

  const unknownQuery = await keywordsGet(
    new Request("https://app.test/api/customer/questions/research/keywords?brand_key=offcult.in&extra=1"),
    {},
    {
      requireWorkspace: async () => dummyWorkspace,
      isFeatureEnabled: async () => true,
    },
  );
  await expectError(unknownQuery, 400, "invalid_request");

  const req = new Request("https://app.test/api/customer/questions/research/keywords?brand_key=offcult.in");
  const res = await keywordsGet(req, {}, {
    requireWorkspace: async () => dummyWorkspace,
    isFeatureEnabled: async () => true,
    listResearchKeywords: async () => ({ keywords: ["streetwear", "anime tees"] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).keywords, ["streetwear", "anime tees"]);
});

function flagAdmin(rows) {
  return {
    from() {
      return {
        select() {
          return {
            in: async () => ({ data: rows, error: null }),
          };
        },
      };
    },
  };
}

function realFlagGate(env, admin) {
  return (name, brandKey) => isFeatureEnabled(name, brandKey, { env, admin });
}

test("AC-21 distinguishes feature-off from an enabled feature with disabled spend controls", async () => {
  const baseEnv = {
    NODE_ENV: "production",
    FEATURE_QUESTION_CURATION: "on",
  };
  const disabledControls = [
    { feature: "questions.setup", enabled: false, mode: "all", brand_allowlist: [] },
    { feature: "questions.generate", enabled: true, mode: "all", brand_allowlist: [] },
    { feature: "questions.research", enabled: false, mode: "all", brand_allowlist: [] },
  ];

  const setupOffEnv = { ...baseEnv, FEATURE_QUESTION_SETUP: "off" };
  const setupOffAdmin = flagAdmin(disabledControls);
  invalidateFeatureFlagCache();
  const setupOff = await setupPost(setupRequest(), {}, {
    requireWorkspace: async () => ({ ...dummyWorkspace, brandKey: "setup-off.example", admin: setupOffAdmin }),
    isFeatureEnabled: realFlagGate(setupOffEnv, setupOffAdmin),
    env: setupOffEnv,
  });
  await expectError(setupOff, 404, "feature_unavailable");

  const setupOnEnv = { ...baseEnv, FEATURE_QUESTION_SETUP: "on" };
  const setupOnAdmin = flagAdmin(disabledControls);
  invalidateFeatureFlagCache();
  const setupDisabled = await setupPost(setupRequest(), {}, {
    requireWorkspace: async () => ({ ...dummyWorkspace, brandKey: "setup-disabled.example", admin: setupOnAdmin }),
    isFeatureEnabled: realFlagGate(setupOnEnv, setupOnAdmin),
    env: setupOnEnv,
  });
  await expectError(setupDisabled, 403, "feature_disabled");

  invalidateFeatureFlagCache();
  const generateDisabled = await generatePost(generateRequest(), {}, {
    requireWorkspace: async () => ({ ...dummyWorkspace, brandKey: "generate-disabled.example", admin: setupOnAdmin }),
    isFeatureEnabled: realFlagGate(setupOnEnv, setupOnAdmin),
    env: setupOnEnv,
  });
  await expectError(generateDisabled, 403, "feature_disabled");

  const researchOffEnv = { ...baseEnv, FEATURE_PROMPT_RESEARCH: "off" };
  const researchOffAdmin = flagAdmin(disabledControls);
  invalidateFeatureFlagCache();
  const researchOff = await researchPost(researchRequest(), {}, {
    requireWorkspace: async () => ({ ...dummyWorkspace, brandKey: "research-off.example", admin: researchOffAdmin }),
    isFeatureEnabled: realFlagGate(researchOffEnv, researchOffAdmin),
    env: researchOffEnv,
  });
  await expectError(researchOff, 404, "feature_unavailable");

  const researchOnEnv = { ...baseEnv, FEATURE_PROMPT_RESEARCH: "on" };
  const researchOnAdmin = flagAdmin(disabledControls);
  invalidateFeatureFlagCache();
  const researchDisabled = await researchPost(researchRequest(), {}, {
    requireWorkspace: async () => ({ ...dummyWorkspace, brandKey: "research-disabled.example", admin: researchOnAdmin }),
    isFeatureEnabled: realFlagGate(researchOnEnv, researchOnAdmin),
    env: researchOnEnv,
  });
  await expectError(researchDisabled, 403, "feature_disabled");

  invalidateFeatureFlagCache();
  const keywordDisabled = await keywordsGet(
    new Request("https://app.test/api/customer/questions/research/keywords?brand_key=research-keywords-disabled.example"),
    {},
    {
      requireWorkspace: async () => ({ ...dummyWorkspace, brandKey: "research-keywords-disabled.example", admin: researchOnAdmin }),
      isFeatureEnabled: realFlagGate(researchOnEnv, researchOnAdmin),
      env: researchOnEnv,
    },
  );
  await expectError(keywordDisabled, 403, "feature_disabled");
  invalidateFeatureFlagCache();
});
