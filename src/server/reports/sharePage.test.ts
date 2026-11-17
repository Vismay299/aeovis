// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/sharePage.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// F23-AC-13 (§6.2.6): the `/s/[token]` wrapper. Static HTML with every report
// value escaped, the preview tags, the hashed share script, and dead ends
// that name no report title.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { REPORT_IFRAME_SANDBOX } from "../../shared/report-sandbox.ts";
import {
  escapeHtml,
  formatUpdatedAgo,
  handleSharePage,
  renderSharePageHtml,
  renderUnavailableHtml,
  SHARE_SCRIPT,
  SHARE_SCRIPT_SHA256,
  shareDescription,
  WRAPPER_CSP,
  type SharePageDeps,
  type SharedReportRow,
} from "./sharePage.ts";

const TOKEN = "a".repeat(32);
const request = (token = TOKEN) => new Request(`https://app.example.com/s/${token}`);

const SHARED_ROW: SharedReportRow = {
  id: "11111111-1111-1111-8111-111111111111",
  brand_key: "brand-a",
  title: "Acme Tees <SEO> audit",
  summary: '\nFix the "titles" first.\n\nThen the meta descriptions.',
  updated_at: "2026-09-01T10:00:00.000Z",
  skill: null,
  website_host: "acme.example",
  workspace_active: true,
  sanitizer_version: 1,
};

function depsFor(row: SharedReportRow | null, flag = true): { deps: SharePageDeps; calls: string[] } {
  const calls: string[] = [];
  const admin = {
    rpc: async (fn: string, args: unknown) => {
      calls.push(fn);
      void args;
      if (fn === "get_shared_report") return { data: row ? [row] : [], error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return {
    deps: {
      getSupabaseAdmin: () => admin as unknown as SupabaseClient,
      isFeatureEnabled: async () => flag,
      now: () => new Date("2026-09-02T10:00:00.000Z"),
    },
    calls,
  };
}

const SHARE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": WRAPPER_CSP,
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

test("puts the framed document, the escaped title and the preview tags in the first response", async () => {
  const { deps } = depsFor(SHARED_ROW);

  const response = await handleSharePage(TOKEN, request(), deps);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers), SHARE_HEADERS);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes(`<iframe src="/s/${TOKEN}/raw" sandbox="${REPORT_IFRAME_SANDBOX}"`));
  assert.ok(html.includes('referrerpolicy="no-referrer"'));
  assert.ok(html.includes("<title>Acme Tees &lt;SEO&gt; audit · Perceev</title>"));
  assert.ok(html.includes('<meta property="og:description" content="Fix the &quot;titles&quot; first.">'));
  assert.ok(html.includes('<meta name="description" content="Fix the &quot;titles&quot; first.">'));
  assert.ok(html.includes(`<meta property="og:url" content="https://app.example.com/s/${TOKEN}">`));
  assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
  assert.ok(html.includes(`<meta property="og:image" content="https://app.example.com/s/${TOKEN}/og.png?v=2026-09-01T10%3A00%3A00.000Z">`));
  assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
  assert.ok(html.includes('<meta property="og:image:height" content="630">'));
  assert.ok(html.includes('<meta property="og:image:alt" content="Acme Tees &lt;SEO&gt; audit · Perceev">'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(html.includes("Made with Perceev"));
  assert.ok(html.includes("Try Perceev"));
  assert.ok(html.includes(`<script>${SHARE_SCRIPT}</script>`));
  // No app bundle: the reader has never signed in and needs none of it.
  assert.ok(!html.includes("/assets/"));
  assert.ok(!html.includes("allow-same-origin"));
});

test("escapes a hostile title and summary everywhere they appear", async () => {
  const { deps } = depsFor({
    ...SHARED_ROW,
    title: '<script>alert(1)</script> "quoted"',
    summary: 'Line "one" & <two>',
  });

  const html = await (await handleSharePage(TOKEN, request(), deps)).text();

  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot;"));
  assert.ok(html.includes('content="Line &quot;one&quot; &amp; &lt;two&gt;"'));
  assert.ok(html.includes('title="&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot;"'));
});

test("the wrapper CSP authorises exactly the share script hash", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SHARE_SCRIPT));
  const recomputed = Buffer.from(digest).toString("base64");

  assert.equal(SHARE_SCRIPT_SHA256, recomputed);
  assert.ok(WRAPPER_CSP.includes(`script-src 'sha256-${SHARE_SCRIPT_SHA256}'`));
});

test("escapeHtml covers the five characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#x27;");
});

test("names the inactive state without naming the report", async () => {
  const { deps } = depsFor({ ...SHARED_ROW, workspace_active: false });

  const response = await handleSharePage(TOKEN, request(), deps);
  const html = await response.text();

  assert.equal(response.status, 404);
  assert.deepEqual(Object.fromEntries(response.headers), SHARE_HEADERS);
  assert.ok(html.includes("This report isn&#x27;t available."));
  assert.ok(html.includes("Its workspace is no longer active."));
  assert.ok(!html.includes("Acme Tees"));
  assert.ok(!html.includes("og:image"));
  assert.ok(!html.includes("twitter:image"));
});

test("a revoked link and a guessed one are the same answer", async () => {
  for (const [name, row] of [["unknown or revoked", null]] as Array<[string, SharedReportRow | null]>) {
    const { deps, calls } = depsFor(row);
    const response = await handleSharePage(TOKEN, request(), deps);
    const html = await response.text();

    assert.equal(response.status, 404, name);
    assert.deepEqual(Object.fromEntries(response.headers), SHARE_HEADERS, name);
    assert.ok(html.includes("This report isn&#x27;t shared."), name);
    assert.ok(html.includes("The link may have been turned off, or the report may have been deleted."), name);
    assert.ok(!html.includes("Acme Tees"), name);
    assert.ok(!html.includes("og:image"), name);
    assert.ok(!html.includes("twitter:image"), name);
    assert.deepEqual(calls, ["get_shared_report"], name);
  }
});

test("a malformed token is refused before the database is asked", async () => {
  const { deps, calls } = depsFor(SHARED_ROW);

  const response = await handleSharePage("nope", request("nope"), deps);

  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes("This report isn&#x27;t shared."));
  assert.deepEqual(calls, []);
});

test("a flag-off workspace reads as never shared", async () => {
  const { deps } = depsFor(SHARED_ROW, false);

  const response = await handleSharePage(TOKEN, request(), deps);
  const html = await response.text();

  assert.equal(response.status, 404);
  assert.ok(html.includes("This report isn&#x27;t shared."));
  assert.ok(!html.includes("Acme Tees"));
});

test("shareDescription takes the first line and caps at 200 chars", () => {
  assert.equal(shareDescription(""), "");
  assert.equal(shareDescription("\n  \n"), "");
  assert.equal(shareDescription('\nFix the "titles" first.\n\nThen.'), 'Fix the "titles" first.');
  const long = `x${"y".repeat(300)}`;
  const capped = shareDescription(long);
  assert.equal(capped.length, 200);
  assert.ok(capped.endsWith("…"));
});

test("formatUpdatedAgo follows the documented buckets", () => {
  const now = new Date("2026-11-17T12:00:00.000Z");
  assert.equal(formatUpdatedAgo("2026-11-17T11:59:30.000Z", now), "just now");
  assert.equal(formatUpdatedAgo("2026-11-17T11:02:00.000Z", now), "58 min ago");
  assert.equal(formatUpdatedAgo("2026-11-17T09:00:00.000Z", now), "3 h ago");
  assert.equal(formatUpdatedAgo("2026-11-16T12:00:00.000Z", now), "yesterday");
  assert.equal(formatUpdatedAgo("2026-11-10T12:00:00.000Z", now), "7 days ago");
  assert.equal(formatUpdatedAgo("2025-11-17T12:00:00.000Z", now), "on Nov 17, 2025");
});

test("renderUnavailableHtml escapes its copy and carries the Try button", () => {
  const html = renderUnavailableHtml("<b>Head</b>", '"Detail" & more');

  assert.ok(html.includes("<h1>&lt;b&gt;Head&lt;/b&gt;</h1>"));
  assert.ok(html.includes("<p>&quot;Detail&quot; &amp; more</p>"));
  assert.ok(html.includes("Try Perceev"));
  assert.ok(html.includes('href="https://perceev.com/?utm_source=shared_report"'));
});

test("renderSharePageHtml omits the description tags when there is none", () => {
  const html = renderSharePageHtml({
    title: "T",
    description: "",
    canonical: "https://app.example.com/s/abc",
    imageUrl: "https://app.example.com/s/abc/og.png?v=x",
    token: "abc",
    updatedAgo: "just now",
  });

  assert.ok(!html.includes("og:description"));
  assert.ok(!html.includes('name="description"'));
});
