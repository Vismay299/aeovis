import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_ANSWER, resolveEnabledEngines, summarizeEngineSlice } from "./enginePipeline.js";

/**
 * R2.2.1 — a 200 with an empty body must be an error row, not an answered one.
 *
 * The old code set `answer_present = true` for every text-engine probe that did
 * not throw, then ran mention detection only `if (result.text)`. An empty
 * answer therefore reached scoring as answered-and-not-mentioned: it entered
 * the denominator at summarizeEngineSlice and contributed nothing to the
 * numerator. The engine had not reported the brand absent — it had reported
 * nothing — so the rate measured a claim nobody made.
 *
 * These drive the LIVE path: resolveEnabledEngines picks the registry def that
 * scanWorker.js:496 calls, which wraps probeTextEngine around the real
 * probeChatGpt. Only `fetch` is mocked, so a change to the registry wiring
 * fails these too.
 */

const ENV = ["ENGINES", "OPENAI_API_KEY", "OPENAI_MODEL"];

function useEnv(t, env) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

/**
 * An OpenAI Responses payload carrying `text` (and optional annotations).
 *
 * `role: "assistant"` is required — openai.js:73 filters on it. Omitting it
 * makes every payload parse to empty text, which silently turns the "real
 * answer" cases into empty ones and lets the empty-answer tests pass for the
 * wrong reason. That happened on the first run of this file.
 */
function openAiPayload(text, annotations = []) {
  return {
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function mockFetch(t, payload) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });
  t.after(() => {
    globalThis.fetch = original;
  });
}

const QUERY = { text: "best crm for small teams", topic: "General", source: "test" };

/** Run one query through the real chatgpt engine def with a mocked transport. */
async function probeOnce(t, payload) {
  useEnv(t, { ENGINES: "chatgpt", OPENAI_API_KEY: "sk-test" });
  mockFetch(t, payload);

  const engines = resolveEnabledEngines();
  const chatgpt = engines.find((e) => e.name === "chatgpt");
  assert.ok(chatgpt, "the chatgpt engine def must resolve — this is the live registry");

  return chatgpt.probe(QUERY, "Acme", ["Acme"], "acme.io", ["Rival"], null);
}

test("an empty 200 produces an error row, not an answered row", async (t) => {
  const row = await probeOnce(t, openAiPayload(""));

  assert.equal(row.answer_present, false, "an empty answer must not count as answered");
  assert.equal(row.error, EMPTY_ANSWER, "it must be typed as an error");
  assert.equal(row.visible, false);
  assert.equal(row.brand_mentioned_in_text, false);
});

test("whitespace-only text is empty too", async (t) => {
  const row = await probeOnce(t, openAiPayload("   \n  "));

  assert.equal(row.answer_present, false);
  assert.equal(row.error, EMPTY_ANSWER);
});

test("an answer with citations but no text still counts as answered", async (t) => {
  // Matches probeAio's predicate at :64-69 — text OR citations. It did respond.
  const row = await probeOnce(
    t,
    openAiPayload("", [{ type: "url_citation", url: "https://acme.io/pricing", title: "Pricing" }])
  );

  assert.equal(row.answer_present, true);
  assert.equal(row.error, null);
  assert.equal(row.brand_cited, true, "the brand's own domain was cited");
  assert.equal(row.visible, true);
});

test("a real answer is unaffected", async (t) => {
  const row = await probeOnce(t, openAiPayload("Acme is a strong CRM for small teams."));

  assert.equal(row.answer_present, true);
  assert.equal(row.error, null);
  assert.equal(row.brand_mentioned_in_text, true);
  assert.equal(row.visible, true);
});

test("THE POINT — an empty answer stays out of the rate's denominator", async (t) => {
  const real = await probeOnce(t, openAiPayload("Acme is a strong CRM."));
  const empty = await probeOnce(t, openAiPayload(""));

  const summary = summarizeEngineSlice([real, empty], "chatgpt");
  assert.equal(summary.errored_queries, 1, "the empty answer counts as an error");

  const withAnswer = [real, empty].filter((r) => r.answer_present);
  assert.equal(withAnswer.length, 1, "only the real answer is in the denominator");

  // The regression this guards: under the old behaviour both rows were
  // answer_present, so a brand named in the one real answer scored 50% instead
  // of 100% — halved by a row the engine never produced.
  const rate = (withAnswer.filter((r) => r.visible).length / withAnswer.length) * 100;
  assert.equal(rate, 100);
});
