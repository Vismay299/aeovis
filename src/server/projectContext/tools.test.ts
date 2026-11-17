import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { projectContextSchema } from "../../shared/project-context.ts";
import { createMemoryProjectContextRepository } from "./memoryRepository.ts";
import {
  getProjectContextTool,
  projectContextTools,
  updateProjectContextTool,
  type ProjectContextToolContext,
} from "./tools.ts";
import type { WorkspaceBrand } from "./service.ts";

const fixedNow = () => new Date("2026-10-25T00:30:00.000Z");
const brand: WorkspaceBrand = {
  brandKey: "offcult.in",
  display_name: "Offcult",
  website: "https://offcult.in",
  website_host: "www.offcult.in",
  aliases: ["Offcult", "offcult"],
};

function context(overrides: Partial<ProjectContextToolContext> = {}): ProjectContextToolContext {
  return {
    admin: {} as SupabaseClient,
    brand,
    userId: "user-1",
    deps: { repo: createMemoryProjectContextRepository({ now: fixedNow }), now: fixedNow },
    ...overrides,
  };
}

test("the tools carry the §6.2.8 names and descriptions verbatim", () => {
  assert.deepEqual(projectContextTools.map((tool) => tool.name), ["get_project_context", "update_project_context"]);
  assert.equal(
    getProjectContextTool.description,
    "Read this workspace's memory: business overview, goal, positioning, writing preferences, custom sections, declared competitors, key pages and the research log. Call before research or writing. Use the research log to avoid buying the same research twice within 90 days.",
  );
  assert.equal(
    updateProjectContextTool.description,
    "Apply 1–50 edits to this workspace's memory in one atomic batch. Saved values are authoritative: only fill what is missing or what the user asked to change.",
  );
});

test("both inputs are closed objects and both outputs are loose objects", () => {
  for (const tool of projectContextTools) {
    const input = z.toJSONSchema(tool.input, { io: "input" }) as { additionalProperties?: unknown };
    assert.equal(input.additionalProperties, false, `${tool.name}: the input must be closed`);
    const output = z.toJSONSchema(tool.output, { io: "output" }) as { additionalProperties?: unknown };
    assert.notEqual(output.additionalProperties, false, `${tool.name}: the output must stay loose`);
  }
});

test("get_project_context accepts only an empty object", () => {
  assert.deepEqual(getProjectContextTool.input.parse({}), {});
  assert.equal(getProjectContextTool.input.safeParse({ brand: "offcult.in" }).success, false);
});

test("update_project_context enforces the 1–50 wire batch bound", () => {
  assert.equal(updateProjectContextTool.input.safeParse({ updates: [] }).success, false);
  const one = { updates: [{ section: "business_overview", content: "Tees" }] };
  assert.equal(updateProjectContextTool.input.safeParse(one).success, true);
  const fiftyOne = {
    updates: Array.from({ length: 51 }, () => ({ section: "business_overview", content: "Tees" })),
  };
  assert.equal(updateProjectContextTool.input.safeParse(fiftyOne).success, false);
  assert.equal(
    updateProjectContextTool.input.safeParse({ updates: [{ section: "business_overview", content: "Tees" }], extra: 1 }).success,
    false,
    "an unknown field is refused rather than ignored",
  );
});

test("get_project_context returns the digest plus a context that parses", async () => {
  const result = await getProjectContextTool.handler(context());
  assert.equal(typeof result.markdown, "string");
  assert.match(result.markdown, /^# Project context\n/);
  const parsed = projectContextSchema.safeParse(result.context);
  assert.equal(parsed.success, true);
  assert.deepEqual(getProjectContextTool.output.safeParse(result).success, true);
});

test("update_project_context writes as the assistant, with no actor and assistant-sourced competitors", async () => {
  const ctx = context();
  const result = await updateProjectContextTool.handler(ctx, {
    updates: [
      { section: "business_overview", content: "Oversized tees, India" },
      { addCompetitors: [{ domain: "https://www.thesouledstore.com/", name: "The Souled Store" }] },
    ],
  });

  assert.deepEqual(Object.keys(result), ["markdown"]);
  assert.match(result.markdown, /Oversized tees, India/);

  const repo = ctx.deps?.repo as ReturnType<typeof createMemoryProjectContextRepository>;
  const section = repo.sections.get(`${brand.brandKey}\0business_overview`);
  assert.equal(section?.updatedBy, "assistant");
  assert.equal(section?.updatedByUser, null);
  const competitor = repo.competitors.get(`${brand.brandKey}\0thesouledstore.com`);
  assert.equal(competitor?.source, "assistant");
  assert.equal(competitor?.updatedBy, "assistant");
});

test("applyContextUpdates still stores competitors as \"manual\" for every non-tool caller", async () => {
  const repo = createMemoryProjectContextRepository({ now: fixedNow });
  const { applyContextUpdates } = await import("./service.ts");
  await applyContextUpdates(
    {} as SupabaseClient,
    brand,
    [{ addCompetitors: [{ domain: "bewakoof.com" }] }],
    "user",
    "user-1",
    { repo, now: fixedNow },
  );
  assert.equal(repo.competitors.get(`${brand.brandKey}\0bewakoof.com`)?.source, "manual");
});
