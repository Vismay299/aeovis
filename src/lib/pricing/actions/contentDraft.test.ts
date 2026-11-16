import test from "node:test";
import assert from "node:assert/strict";
import { getPricedAction, quote } from "../pricedActions.ts";
import "./index.ts"; // registers all actions
import { contentDraftCap, contentDraftInput } from "./contentDraft.ts";

const CAP_NOTE =
  "The content pipeline checks this limit after each step, so a draft can pass it by the cost of one step.";

function context(env: Record<string, string | undefined>) {
  return {
    brandKey: "brand-a",
    admin: {} as any,
    env,
    now: new Date("2026-11-17T09:00:00.000Z"),
  };
}

test("content.draft.run is registered with the content.draft spend feature and approval", () => {
  const action = getPricedAction("content.draft.run");
  assert.ok(action);
  assert.equal(action.key, "content.draft.run");
  assert.equal(action.feature, "content.draft");
  assert.equal(action.requireApproval, true);
});

test("the quote uses CONTENT_MAX_COST_PER_ITEM when it is a positive number", async () => {
  const priced = await quote("content.draft.run", context({ CONTENT_MAX_COST_PER_ITEM: "0.25" }), {});

  assert.equal(priced.totalUsd, 0.25);
  assert.equal(priced.expectedUsd, null);
  assert.deepEqual(priced.lines, [
    {
      label: "Research, drafting and fact-checking for one draft",
      quantity: 1,
      unitUsd: 0.25,
      totalUsd: 0.25,
    },
  ]);
  assert.deepEqual(priced.warnings, [{ code: "cap_note", message: CAP_NOTE }]);
  assert.equal(priced.blocked, null);
});

test("an unset cap falls back to 0.15", async () => {
  const priced = await quote("content.draft.run", context({}), {});
  assert.equal(priced.totalUsd, 0.15);
  assert.equal(priced.lines[0].unitUsd, 0.15);
});

test('an empty or "0" cap is treated as unset', async () => {
  assert.equal(contentDraftCap({ CONTENT_MAX_COST_PER_ITEM: "" }), 0.15);
  assert.equal(contentDraftCap({ CONTENT_MAX_COST_PER_ITEM: "0" }), 0.15);
  assert.equal(contentDraftCap({ CONTENT_MAX_COST_PER_ITEM: "not-a-number" }), 0.15);

  const empty = await quote("content.draft.run", context({ CONTENT_MAX_COST_PER_ITEM: "" }), {});
  const zero = await quote("content.draft.run", context({ CONTENT_MAX_COST_PER_ITEM: "0" }), {});
  assert.equal(empty.totalUsd, 0.15);
  assert.equal(zero.totalUsd, 0.15);
});

test("the input is strict and the format defaults to geo_article", async () => {
  assert.equal(contentDraftInput.parse({}).format, "geo_article");
  assert.equal(contentDraftInput.safeParse({ format: "geo_article", unexpected: true }).success, false);

  const action = getPricedAction("content.draft.run");
  assert.ok(action);
  assert.equal(action.input.safeParse({ format: "linkedin_post", unexpected: true }).success, false);
  await assert.rejects(() => quote("content.draft.run", context({}), { unexpected: true }));
});
