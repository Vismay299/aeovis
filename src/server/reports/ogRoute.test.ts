// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/shareImageRoute.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// F23-AC-14 unit half (§6.2.7): the `/s/[token]/og.png` access checks and the
// render-failure fallback. The renderer is injected — the real one needs
// next/og — so this suite proves the handler, not the pixels. Perceev answers
// a failed render with 500 text, not a marketing-card redirect.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleReportSocialImage,
  NOT_SHARED_BODY,
  type DocDeps,
  type SocialImageRenderer,
} from "./documentRoutes.ts";
import type { SharedReportRow } from "./sharePage.ts";

const TOKEN = "a".repeat(32);

const SHARED_ROW: SharedReportRow = {
  id: "11111111-1111-1111-8111-111111111111",
  brand_key: "brand-a",
  title: "Acme Tees AI visibility audit",
  summary: "One clear verdict.",
  skill: null,
  updated_at: "2026-11-17T12:00:00.000Z",
  website_host: "acme.example",
  workspace_active: true,
  sanitizer_version: 1,
};

function harness(opts: {
  row?: SharedReportRow | null;
  flag?: boolean;
  render?: SocialImageRenderer;
  lookupError?: unknown;
} = {}) {
  const { row = { ...SHARED_ROW }, flag = true, lookupError } = opts;
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const renderCalls: Array<{ title: string; host: string | null }> = [];
  const render: SocialImageRenderer =
    opts.render ??
    (async (title, host) => {
      renderCalls.push({ title, host });
      return new Response("image");
    });
  const admin = {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_shared_report") {
        if (lookupError) throw lookupError;
        return { data: row ? [row] : [], error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  const deps: DocDeps & { render: SocialImageRenderer } = {
    getSupabaseAdmin: () => admin as unknown as SupabaseClient,
    isFeatureEnabled: async () => flag,
    render,
  };
  return { deps, rpcCalls, renderCalls };
}

test("renders the title from the authorized report", async () => {
  const { deps, rpcCalls, renderCalls } = harness();

  const response = await handleReportSocialImage(TOKEN, deps);

  assert.equal(await response.text(), "image");
  assert.deepEqual(rpcCalls, [{ fn: "get_shared_report", args: { p_token: TOKEN } }]);
  assert.deepEqual(renderCalls, [{ title: "Acme Tees AI visibility audit", host: "acme.example" }]);
});

test("passes a null host through when the workspace has none", async () => {
  const { deps, renderCalls } = harness({ row: { ...SHARED_ROW, website_host: null } });

  await handleReportSocialImage(TOKEN, deps);

  assert.deepEqual(renderCalls, [{ title: "Acme Tees AI visibility audit", host: null }]);
});

test("a render failure answers 500 text with no-store and noindex", async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const { deps } = harness({
      render: async () => {
        throw new Error("Renderer failed");
      },
    });

    const response = await handleReportSocialImage(TOKEN, deps);

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Preview image unavailable.");
    assert.deepEqual(Object.fromEntries(response.headers), {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    assert.deepEqual(errors, [["[reports] social image failed"]]);
  } finally {
    console.error = original;
  }
});

test("does not hide a report lookup failure behind the fallback", async () => {
  const { deps, renderCalls } = harness({ lookupError: new Error("Database unavailable") });

  await assert.rejects(handleReportSocialImage(TOKEN, deps), /Database unavailable/);
  assert.deepEqual(renderCalls, []);
});

test("does not reveal a missing or inactive report's title", async () => {
  for (const row of [null, { ...SHARED_ROW, workspace_active: false }]) {
    const { deps, renderCalls, rpcCalls } = harness({ row });

    const response = await handleReportSocialImage(TOKEN, deps);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(await response.text(), NOT_SHARED_BODY);
    assert.deepEqual(renderCalls, []);
    assert.ok(rpcCalls.length > 0);
  }
});

test("skips the lookup and the render when the shape is wrong", async () => {
  const { deps, rpcCalls, renderCalls } = harness();

  const response = await handleReportSocialImage("bad", deps);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), NOT_SHARED_BODY);
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(renderCalls, []);
});

test("skips the render when sharing is off", async () => {
  const { deps, renderCalls } = harness({ flag: false });

  const response = await handleReportSocialImage(TOKEN, deps);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), NOT_SHARED_BODY);
  assert.deepEqual(renderCalls, []);
});
