import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../customerRoutes.test.hooks.mjs", import.meta.url);
const route = await import("../../app/api/customer/repairs/[kind]/route.js");

const QUESTION_ID = "22222222-2222-4222-8222-222222222222";

function setup() {
  const calls = [];
  const admin = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "sync_panel_questions") {
        return {
          data: {
            revision: 1,
            ids: args.p_prompts.map((prompt) => ({ text: prompt.text, question_id: QUESTION_ID })),
          },
          error: null,
        };
      }
      if (name === "backfill_workspace_questions") {
        return { data: { skipped: true }, error: null };
      }
      if (name === "append_repair_artifact") {
        return {
          data: {
            id: "11111111-1111-4111-8111-111111111111",
            brand: args.p_brand,
            kind: args.p_kind,
            artifact_key: args.p_key,
            state: args.p_state,
            payload: args.p_payload,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  globalThis.customerRouteFixture = {
    admin,
    context: {
      client: admin,
      user: { id: "owner-a" },
      error: null,
      brands: [{
        brandKey: "workspace-a",
        display_name: "Offcult",
        website: "https://offcult.in",
        role: "owner",
      }],
    },
  };
  return { calls };
}

function request(state) {
  return new Request("https://app.example.test/api/customer/repairs/panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      expected_version: 0,
      payload: {
        persona: "Indian small business buyers",
        context: { country: "in", language: "en" },
        prompts: [{ text: "Which accounting systems suit teams?", origin: "manual" }],
      },
    }),
  });
}

test("an approved legacy panel syncs stable question IDs into its frozen artifact", async () => {
  const { calls } = setup();
  const response = await route.POST(request("approved"), { params: { kind: "panel" } });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["item"]);
  assert.equal(body.item.payload.prompts[0].id, QUESTION_ID);
  assert.equal(body.item.payload.prompts[0].question_id, QUESTION_ID);
  assert.deepEqual(calls.map((item) => item.name), [
    "backfill_workspace_questions",
    "sync_panel_questions",
    "append_repair_artifact",
  ]);
  assert.equal(calls[1].args.p_prompts[0].text, "Which accounting systems suit teams?");
});

test("a draft legacy panel keeps its response shape and does not sync workspace questions", async () => {
  const { calls } = setup();
  const response = await route.POST(request("draft"), { params: { kind: "panel" } });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["item"]);
  assert.equal("question_id" in body.item.payload.prompts[0], false);
  assert.deepEqual(calls.map((item) => item.name), ["append_repair_artifact"]);
});
