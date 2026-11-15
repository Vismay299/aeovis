import test from "node:test";
import assert from "node:assert/strict";
import { trackKeywordAsAiQuestion, mapAioStatus, aiStatusesForKeywords } from "./aiQuestions.ts";

test("mapAioStatus mapping logic", () => {
  assert.equal(mapAioStatus(null), "not_measured");
  assert.equal(mapAioStatus({ state: "pending", aio_present: null, own_cited: null, own_mentioned: null }), "not_measured");
  assert.equal(mapAioStatus({ state: "valid_no_aio", aio_present: false, own_cited: false, own_mentioned: false }), "no_overview");
  assert.equal(mapAioStatus({ state: "answered", aio_present: true, own_cited: true, own_mentioned: true }), "cited");
  assert.equal(mapAioStatus({ state: "answered", aio_present: true, own_cited: false, own_mentioned: true }), "mentioned");
  assert.equal(mapAioStatus({ state: "answered", aio_present: true, own_cited: false, own_mentioned: false }), "absent");
});

test("trackKeywordAsAiQuestion validates keyword belongs to tracker", async () => {
  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }),
  };

  await assert.rejects(
    () => trackKeywordAsAiQuestion({ brandKey: "b1", userId: "u1" }, "cfg-1", "kw-missing", { text: "What is coffee?" }, { admin: admin as any }),
    (err: any) => err.code === "keyword_not_found" && err.status === 404,
  );
});

test("trackKeywordAsAiQuestion passes sourceRef and calls injected addWorkspaceQuestion", async () => {
  const kwId = "kw-123";
  const cfgId = "cfg-456";
  const qId = "q-789";

  let capturedAddArgs: any = null;
  const fakeAdd = async (_admin: any, args: any) => {
    capturedAddArgs = args;
    return {
      question: { id: qId, text: args.text, topic: args.topic, origin: args.origin },
      created: true,
      revived: false,
    };
  };

  let upsertCalled = false;
  let upsertPayload: any = null;

  const admin = {
    from: (table: string) => {
      if (table === "rank_tracking_keywords") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: kwId, keyword: "espresso machine", config_id: cfgId },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "rank_tracking_configs") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { location_code: 2840, language_code: "en" },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "rank_keyword_questions") {
        return {
          upsert: async (payload: any) => {
            upsertCalled = true;
            upsertPayload = payload;
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };

  const res = await trackKeywordAsAiQuestion(
    { brandKey: "b1", userId: "u1" },
    cfgId,
    kwId,
    { text: "Best espresso machine for home?", topic: "Espresso" },
    { admin: admin as any, add: fakeAdd as any },
  );

  assert.equal(res.questionId, qId);
  assert.equal(res.created, true);
  assert.equal(res.revived, false);
  assert.equal(res.linked, true);

  assert.equal(capturedAddArgs.brandKey, "b1");
  assert.equal(capturedAddArgs.text, "Best espresso machine for home?");
  assert.equal(capturedAddArgs.origin, "manual");
  assert.equal(capturedAddArgs.createdBy, "u1");
  assert.equal(capturedAddArgs.topic, "Espresso");
  assert.deepEqual(capturedAddArgs.sourceRef, {
    kind: "rank_keyword",
    trackingKeywordId: kwId,
    keyword: "espresso machine",
    locationCode: 2840,
    languageCode: "en",
  });

  assert.equal(upsertCalled, true);
  assert.equal(upsertPayload.brand_key, "b1");
  assert.equal(upsertPayload.tracking_keyword_id, kwId);
  assert.equal(upsertPayload.question_id, qId);
  assert.equal(upsertPayload.created_by, "u1");
});

test("aiStatusesForKeywords maps 42P01 to not_measured and handles multiple links", async () => {
  const kw1 = "kw-1";
  const kw2 = "kw-2";
  const q1 = "q-1";
  const q2 = "q-2";

  // Mock normal read
  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            order: async () => ({
              data: [
                { tracking_keyword_id: kw1, question_id: q1, created_at: "2026-10-10T12:00:00Z" },
                { tracking_keyword_id: kw1, question_id: "older-q", created_at: "2026-10-09T12:00:00Z" },
                { tracking_keyword_id: kw2, question_id: q2, created_at: "2026-10-10T12:00:00Z" },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async (fn: string, args: any) => {
      assert.equal(fn, "rank_question_aio_status");
      return {
        data: [
          { question_id: q1, collected_at: "2026-10-10T14:00:00Z", state: "answered", aio_present: true, own_cited: true, own_mentioned: true },
          { question_id: q2, collected_at: "2026-10-10T14:00:00Z", state: "valid_no_aio", aio_present: false, own_cited: false, own_mentioned: false },
        ],
        error: null,
      };
    },
  };

  const map = await aiStatusesForKeywords(admin as any, "b1", [kw1, kw2]);
  assert.equal(map.size, 2);
  assert.deepEqual(map.get(kw1), {
    questionId: q1,
    status: "cited",
    measuredAt: "2026-10-10T14:00:00Z",
  });
  assert.deepEqual(map.get(kw2), {
    questionId: q2,
    status: "no_overview",
    measuredAt: "2026-10-10T14:00:00Z",
  });

  // Mock 42P01 on rpc
  const adminMissingF12 = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            order: async () => ({
              data: [
                { tracking_keyword_id: kw1, question_id: q1, created_at: "2026-10-10T12:00:00Z" },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async () => ({
      data: null,
      error: { code: "42P01", message: 'relation "question_answer_links" does not exist' },
    }),
  };

  const fallbackMap = await aiStatusesForKeywords(adminMissingF12 as any, "b1", [kw1]);
  assert.equal(fallbackMap.size, 1);
  assert.deepEqual(fallbackMap.get(kw1), {
    questionId: q1,
    status: "not_measured",
    measuredAt: null,
  });
});
