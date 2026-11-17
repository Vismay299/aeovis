import test from "node:test";
import assert from "node:assert/strict";

const historyRoute = await import("../../../app/api/customer/questions/[questionId]/history/route.ts");
const answerRoute = await import("../../../app/api/customer/questions/[questionId]/answers/[answerId]/route.ts");

const BRAND_KEY = "offcult.in";
const QUESTION_ID = "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182";
const OTHER_QUESTION = "11111111-1111-4111-8111-111111111111";
const ANSWER_ID = "6a1f0000-0000-4000-8000-000000000001";
const SCAN_ID = "9e8d0000-0000-4000-8000-000000000001";

function makeWorkspace() {
  return {
    user: { id: "user-1", email: "owner@example.com" },
    brandKey: BRAND_KEY,
    brand: {
      brandKey: BRAND_KEY,
      role: "member",
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: ["Offcult"],
      is_active: true,
    },
    role: "member",
    admin: {},
  };
}

test("history route 404s unknown question ids before any read", async () => {
  let calls = 0;
  const deps = {
    requireWorkspace: async () => makeWorkspace(),
    getQuestionHistory: async () => {
      calls += 1;
      const { AppError } = await import("../../../shared/http/appError.ts");
      throw new AppError(404, "question_not_found", "This question does not exist in this workspace.");
    },
  };
  const req = new Request(`https://app.test/api/customer/questions/${OTHER_QUESTION}/history?brand_key=${BRAND_KEY}`);
  const res = await historyRoute.GET(req, { params: Promise.resolve({ questionId: OTHER_QUESTION }) }, deps);
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
  const json = await res.json();
  assert.equal(json.code, "question_not_found");
});

test("history route rejects a bad uuid without calling the service", async () => {
  let calls = 0;
  const deps = {
    requireWorkspace: async () => makeWorkspace(),
    getQuestionHistory: async () => {
      calls += 1;
      return {};
    },
  };
  const req = new Request(`https://app.test/api/customer/questions/not-a-uuid/history?brand_key=${BRAND_KEY}`);
  const res = await historyRoute.GET(req, { params: Promise.resolve({ questionId: "not-a-uuid" }) }, deps);
  assert.equal(res.status, 400);
  assert.equal(calls, 0);
  const json = await res.json();
  assert.equal(json.code, "invalid_request");
});

test("history route returns invalid_range when from is after to", async () => {
  let calls = 0;
  const deps = {
    requireWorkspace: async () => makeWorkspace(),
    getQuestionHistory: async () => {
      calls += 1;
      const { AppError } = await import("../../../shared/http/appError.ts");
      throw new AppError(400, "invalid_range", "Choose a start date on or before the end date.");
    },
  };
  const req = new Request(
    `https://app.test/api/customer/questions/${QUESTION_ID}/history?brand_key=${BRAND_KEY}&from=2026-10-21T00:00:00.000Z&to=2026-10-20T00:00:00.000Z`,
  );
  const res = await historyRoute.GET(req, { params: Promise.resolve({ questionId: QUESTION_ID }) }, deps);
  assert.equal(res.status, 400);
  assert.equal(calls, 1);
  const json = await res.json();
  assert.equal(json.code, "invalid_range");
});

test("history route caps at 500 with truncated and contains no answer text", async () => {
  const executions = Array.from({ length: 500 }, (_, index) => ({
    answerId: `6a1f0000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    source: "scan",
    engine: "chatgpt",
    engineLabel: "ChatGPT",
    collectedAt: "2026-10-20T10:12:04.000Z",
    trigger: "manual",
    status: "answered",
    ownMentioned: false,
    ownCited: false,
    askedText: "best oversized t-shirt brands in india",
    scanId: SCAN_ID,
    exploreRunId: null,
    method: "model_api",
    quality: "measured",
  }));
  const deps = {
    requireWorkspace: async () => makeWorkspace(),
    getQuestionHistory: async () => ({
      question: {
        id: QUESTION_ID,
        text: "best oversized t-shirt brands in india",
        topic: null,
        status: "active",
        branded: false,
        origin: "manual",
        replacedBy: null,
        replaces: [],
      },
      range: { from: null, to: null },
      executions,
      summary: [],
      coverage: { total: 500, answered: 500, noAnswer: 0, failed: 0, explore: 0, legacy: 0 },
      truncated: true,
      latestScanId: SCAN_ID,
    }),
  };
  const req = new Request(`https://app.test/api/customer/questions/${QUESTION_ID}/history?brand_key=${BRAND_KEY}`);
  const res = await historyRoute.GET(req, { params: Promise.resolve({ questionId: QUESTION_ID }) }, deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const json = await res.json();
  assert.equal(json.truncated, true);
  assert.equal(json.executions.length, 500);
  assert.ok(!("text" in json));
  assert.ok(!JSON.stringify(json.executions).includes("Popular oversized"));
});

test("answer route 404s cross-workspace answers", async () => {
  const deps = {
    requireWorkspace: async () => makeWorkspace(),
    getQuestionAnswer: async () => {
      const { AppError } = await import("../../../shared/http/appError.ts");
      throw new AppError(404, "answer_not_found", "This answer does not exist in this workspace.");
    },
  };
  const req = new Request(`https://app.test/api/customer/questions/${QUESTION_ID}/answers/${ANSWER_ID}?brand_key=${BRAND_KEY}`);
  const res = await answerRoute.GET(
    req,
    { params: Promise.resolve({ questionId: QUESTION_ID, answerId: ANSWER_ID }) },
    deps,
  );
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.code, "answer_not_found");
});

test("answer route exposes evidence href only for stored captures", async () => {
  const deps = {
    requireWorkspace: async () => makeWorkspace(),
    getQuestionAnswer: async () => ({
      execution: {
        answerId: ANSWER_ID,
        source: "scan",
        engine: "chatgpt",
        engineLabel: "ChatGPT",
        collectedAt: "2026-10-20T10:12:04.000Z",
        trigger: "manual",
        status: "answered",
        ownMentioned: false,
        ownCited: false,
        askedText: "best oversized t-shirt brands in india",
        scanId: SCAN_ID,
        exploreRunId: null,
        method: "model_api",
        quality: "measured",
      },
      text: "Popular oversized t-shirt brands in India include Bewakoof.",
      markdown: null,
      truncated: false,
      citations: [],
      brands: [],
      provenance: {
        method: "model_api",
        methodLabel: "Model API",
        gateway: "openrouter",
        requestedModel: null,
        returnedModel: null,
        requestedLocation: null,
        searchUsed: "unknown",
      },
      evidence: {
        state: "stored",
        captures: [
          {
            index: 0,
            state: "stored",
            href: `/api/customer/measurement/evidence?brand_key=${BRAND_KEY}&observation=obs-1&attempt=att-1&index=0`,
            expiresAt: "2027-01-18T10:12:04.000Z",
          },
        ],
      },
      error: null,
    }),
  };
  const req = new Request(`https://app.test/api/customer/questions/${QUESTION_ID}/answers/${ANSWER_ID}?brand_key=${BRAND_KEY}`);
  const res = await answerRoute.GET(
    req,
    { params: Promise.resolve({ questionId: QUESTION_ID, answerId: ANSWER_ID }) },
    deps,
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.evidence.captures[0].href.includes("/api/customer/measurement/evidence"));
});

