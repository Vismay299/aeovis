import test from "node:test";
import assert from "node:assert/strict";
import { availableTools, filterOwnerTools, getTool, TOOL_REGISTRY } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import type { FeatureName } from "../features/names.ts";
import type { ToolRegistration } from "./types.ts";

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

test("the registry is exactly the declared tool names, unique and sorted", () => {
  const names = TOOL_REGISTRY.map((registration) => registration.def.name);

  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  assert.deepEqual(
    [...names].sort((a, b) => a.localeCompare(b)),
    [...TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    "registry names must equal TOOL_NAMES",
  );
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  for (const name of names) {
    assert.match(name, NAME_RE);
    assert.equal(getTool(name)?.def.name, name);
  }
  assert.equal(getTool("not_a_tool"), null);
});

test("availableTools evaluates each registration feature once and fails closed on rejected flags", async () => {
  const expected = [
    ...new Set(
      TOOL_REGISTRY.map((registration) => registration.feature).filter(
        (feature): feature is FeatureName => feature !== null,
      ),
    ),
  ].sort();

  const calls: string[] = [];
  const member = await availableTools(
    { brandKey: "brand-a", role: "member" },
    {
      isFeatureEnabled: async (feature, key) => {
        calls.push(feature + ":" + key);
        if (feature === "question_curation") throw new Error("fixture");
        return true;
      },
    },
  );

  assert.deepEqual(
    calls.sort(),
    expected.map((feature) => feature + ":brand-a").sort(),
  );
  assert.ok(member.every((registration) => registration.feature !== "question_curation"));
  assert.ok(member.every((registration) => !registration.ownerOnly));
});

test("owner filtering retains owner-only rows only for owners", () => {
  const fixture = { ownerOnly: true } as ToolRegistration;
  assert.deepEqual(filterOwnerTools([fixture], "member"), []);
  assert.deepEqual(filterOwnerTools([fixture], "owner"), [fixture]);
});
