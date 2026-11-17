import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  indexnowTools,
  submitIndexNowUrlsTool,
  type SubmitIndexNowUrlsToolContext,
} from "./tools.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const brand = {
  brandKey: "brand-1",
  role: "owner" as const,
  display_name: "Example",
  website: "https://example.com/",
  website_host: "example.com",
  aliases: [] as string[],
  is_active: true,
};

function context(over: Partial<SubmitIndexNowUrlsToolContext> = {}): SubmitIndexNowUrlsToolContext {
  return { admin: {} as SupabaseClient, brand, userId: "user-1", ...over };
}

const canned = {
  key: "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1",
  keyCreated: false,
  hosts: [
    {
      host: "example.com",
      urlCount: 1,
      status: "submitted" as const,
      engine: "bing" as const,
      httpStatus: 200,
      reason: null,
      message: "Submitted 1 URL.",
    },
  ],
  skipped: [] as Array<{ url: string; reason: "off_site" | "invalid" | "recently_submitted" }>,
};

test("tool carries the F19 §6.2.5 name and description verbatim", () => {
  assert.deepEqual(indexnowTools.map((tool) => tool.name), ["submit_indexnow_urls"]);
  assert.equal(submitIndexNowUrlsTool.name, "submit_indexnow_urls");
  assert.equal(
    submitIndexNowUrlsTool.description,
    "Tells Bing, Yandex, Seznam, Naver, Yep and other IndexNow search engines that pages on this workspace's website changed, so they recrawl them sooner. Google does not use IndexNow. Submit only new, updated, redirected or removed pages, not the whole site. The site must host the workspace key file at the root of each host. URLs outside the website are skipped. Free.",
  );
});

test("input is strict and output is loose", () => {
  const input = z.toJSONSchema(submitIndexNowUrlsTool.input, { io: "input" }) as {
    additionalProperties?: unknown;
  };
  assert.equal(input.additionalProperties, false, "input must be closed");
  const output = z.toJSONSchema(submitIndexNowUrlsTool.output, { io: "output" }) as {
    additionalProperties?: unknown;
  };
  assert.notEqual(output.additionalProperties, false, "output must stay loose");
});

test("strict input refuses unknown fields, empty urls, oversize lists and non-strings", () => {
  assert.equal(
    submitIndexNowUrlsTool.input.safeParse({ urls: ["https://example.com/a"], extra: 1 }).success,
    false,
    "unknown field is refused rather than ignored",
  );
  assert.equal(submitIndexNowUrlsTool.input.safeParse({ urls: [] }).success, false);
  assert.equal(
    submitIndexNowUrlsTool.input.safeParse({ urls: Array.from({ length: 10001 }, () => "https://example.com/a") }).success,
    false,
  );
  assert.equal(
    submitIndexNowUrlsTool.input.safeParse({ urls: ["https://example.com/a", 42] }).success,
    false,
  );
  assert.equal(
    submitIndexNowUrlsTool.input.safeParse({ urls: ["https://example.com/a"] }).success,
    true,
  );
});

test("loose output allows extra metadata keys at the top level and inside rows", () => {
  const withExtras = {
    ...canned,
    traceId: "trace-1",
    hosts: [{ ...canned.hosts[0], elapsedMs: 12 }],
  };
  assert.equal(submitIndexNowUrlsTool.output.safeParse(withExtras).success, true);
  const parsed = submitIndexNowUrlsTool.output.parse(withExtras) as Record<string, unknown>;
  assert.equal(parsed.traceId, "trace-1");
});

test("handler records source tool with a uuid requestId and passes the result through", async () => {
  const calls: Array<{ ws: unknown; input: { urls: string[]; source: string; requestId: string } }> = [];
  const ctx = context({
    deps: {
      submitUrls: (async (admin: unknown, ws: unknown, input: { urls: string[]; source: string; requestId: string }) => {
        calls.push({ ws, input });
        return canned;
      }) as never,
    },
  });
  const result = await submitIndexNowUrlsTool.handler(ctx, { urls: ["https://example.com/a"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.source, "tool");
  assert.match(calls[0].input.requestId, UUID_RE);
  assert.deepEqual(calls[0].input.urls, ["https://example.com/a"]);
  const ws = calls[0].ws as { brandKey: string; user?: { id?: string } | null };
  assert.equal(ws.brandKey, "brand-1");
  assert.equal(ws.user?.id, "user-1");
  assert.deepEqual(result, canned);
});

test("handler generates a fresh requestId per call", async () => {
  const seen: string[] = [];
  const ctx = context({
    deps: {
      submitUrls: (async (_admin: unknown, _ws: unknown, input: { requestId: string }) => {
        seen.push(input.requestId);
        return canned;
      }) as never,
    },
  });
  await submitIndexNowUrlsTool.handler(ctx, { urls: ["https://example.com/a"] });
  await submitIndexNowUrlsTool.handler(ctx, { urls: ["https://example.com/a"] });
  assert.equal(seen.length, 2);
  assert.match(seen[0], UUID_RE);
  assert.match(seen[1], UUID_RE);
  assert.notEqual(seen[0], seen[1]);
});

test("refusal happens before any provider call", async () => {
  let called = false;
  const ctx = context({
    deps: {
      submitUrls: (async () => {
        called = true;
        throw new Error("must not be called");
      }) as never,
    },
  });
  await assert.rejects(submitIndexNowUrlsTool.handler(ctx, { urls: [] }));
  assert.equal(called, false);
  await assert.rejects(submitIndexNowUrlsTool.handler(ctx, { urls: ["https://example.com/a"], extra: 1 }));
  assert.equal(called, false);
});
