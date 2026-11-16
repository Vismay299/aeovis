import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../http/appError.ts";
import { createCheckAiCrawlerAccessTool } from "./aiCrawlers.ts";
import type { ToolHandlerContext } from "../types.ts";

const ROBOTS = ["User-agent: GPTBot", "Disallow: /", "", "User-agent: *", "Allow: /"].join("\n");

function context(overrides: Partial<ToolHandlerContext["brand"]> = {}): ToolHandlerContext {
  return {
    admin: {} as any,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "Acme",
      website: "https://acme.test",
      website_host: "acme.test",
      aliases: [],
      is_active: true,
      ...overrides,
    },
    userId: "user-a",
    user: { id: "user-a", email: "owner@acme.test" },
    role: "owner",
    requestId: "test",
    source: "test",
  };
}

function fixtures() {
  const calls = { robots: [] as string[], llms: [] as string[] };
  const deps = {
    fetchRobots: async (origin: string) => {
      calls.robots.push(origin);
      return { status: "found" as const, httpStatus: 200, text: ROBOTS };
    },
    checkLlmsTxt: async (origin: string) => {
      calls.llms.push(origin);
      return {
        status: "present" as const,
        httpStatus: 200,
        contentType: "text/plain",
        firstLine: "# Acme",
      };
    },
  };
  return { deps, calls };
}

test("the input is strict and has no host field", () => {
  const tool = createCheckAiCrawlerAccessTool();
  assert.equal(tool.input.safeParse({}).success, true);
  assert.deepEqual(tool.input.parse({}), { path: "/" });
  assert.equal(tool.input.safeParse({ path: "/", host: "evil.example" }).success, false);
  assert.equal(tool.input.safeParse({ path: "no-leading-slash" }).success, false);
  assert.equal(tool.input.safeParse({ path: "/has space" }).success, false);
});

test("a workspace with no website refuses with no_website", async () => {
  const { deps, calls } = fixtures();
  const tool = createCheckAiCrawlerAccessTool(deps);

  await assert.rejects(
    () => tool.handler(context({ website: "", website_host: "" }), {}),
    (error) => error instanceof AppError && error.code === "no_website",
  );
  assert.deepEqual(calls.robots, []);
  assert.deepEqual(calls.llms, []);
});

test("the check uses the workspace origin and reports robots, bots and llms.txt", async () => {
  const { deps, calls } = fixtures();
  const tool = createCheckAiCrawlerAccessTool(deps);

  const output = (await tool.handler(context(), {})) as any;

  assert.deepEqual(calls.robots, ["https://acme.test"]);
  assert.deepEqual(calls.llms, ["https://acme.test"]);
  assert.equal(output.host, "acme.test");
  assert.deepEqual(output.robots, { status: "found", httpStatus: 200 });
  assert.deepEqual(output.llmsTxt, { status: "present", httpStatus: 200 });
  assert.deepEqual(output.blocked, {
    search: [],
    agent: [],
    training: ["GPTBot"],
  });
  const gptBot = output.bots.find((bot: any) => bot.name === "GPTBot");
  assert.deepEqual(gptBot, {
    name: "GPTBot",
    operator: "OpenAI",
    platform: "GPT model training",
    purpose: "training",
    status: "blocked",
  });
});

test("the path filter is passed through to the robots evaluation", async () => {
  const deps = {
    fetchRobots: async () => ({
      status: "found" as const,
      httpStatus: 200,
      text: "User-agent: *\nDisallow: /private",
    }),
    checkLlmsTxt: async () => ({
      status: "missing" as const,
      httpStatus: 404,
      contentType: null,
      firstLine: null,
    }),
  };
  const tool = createCheckAiCrawlerAccessTool(deps);

  const root = (await tool.handler(context(), {})) as any;
  const blockedPath = (await tool.handler(context(), { path: "/private/page" })) as any;

  assert.equal(blockedPath.blocked.search.includes("OAI-SearchBot"), true);
  assert.equal(root.blocked.search.includes("OAI-SearchBot"), false);
});
