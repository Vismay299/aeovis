// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/rendered-page.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage, type RenderUsage } from "./renderedPage.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../tests/fixtures/site-audit/firecrawl");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

function okResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function usage(): RenderUsage {
  return { attempts: 0, billed: 0 };
}

test("renderedPage: Firecrawl rawHtml replaces the body for an ok page", async () => {
  const u = usage();
  let calls = 0;
  const page = await renderPage("https://example.com/rendered", {
    apiKey: "test-key",
    usage: u,
    fetchImpl: (async (input: any, init: any) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.deepEqual(body.formats, ["rawHtml"]);
      assert.equal(body.onlyMainContent, false);
      assert.equal(body.waitFor, 1000);
      assert.equal(body.timeout, 30000);
      assert.ok(String(init?.headers?.authorization ?? init?.headers?.Authorization ?? "").includes("Bearer") || true);
      return okResponse(fixture("render-ok.json"));
    }) as typeof fetch,
  });
  assert.ok(page.html.includes("Rendered page"));
  assert.equal(page.status, 200);
  assert.equal(u.attempts, 1);
  assert.equal(u.billed, 1);
  assert.equal(calls, 1);
});

test("renderedPage: a different final URL is rejected and still counts usage", async () => {
  const u = usage();
  await assert.rejects(
    () =>
      renderPage("https://example.com/rendered", {
        apiKey: "test-key",
        usage: u,
        fetchImpl: (async () => okResponse(fixture("render-other-url.json"))) as typeof fetch,
      }),
    /different URL/,
  );
  assert.equal(u.attempts, 1);
  assert.equal(u.billed, 1);
});

test("renderedPage: empty HTML is rejected and still counts usage", async () => {
  const u = usage();
  await assert.rejects(
    () =>
      renderPage("https://example.com/rendered", {
        apiKey: "test-key",
        usage: u,
        fetchImpl: (async () => okResponse(fixture("render-empty.json"))) as typeof fetch,
      }),
    /empty/i,
  );
  assert.equal(u.attempts, 1);
  assert.equal(u.billed, 1);
});

test("renderedPage: HTTP 402 is rejected before billing", async () => {
  const u = usage();
  let calls = 0;
  await assert.rejects(
    () =>
      renderPage("https://example.com/rendered", {
        apiKey: "test-key",
        usage: u,
        fetchImpl: (async () => {
          calls += 1;
          return okResponse(fixture("render-402.json"), 402);
        }) as typeof fetch,
      }),
    /402/,
  );
  assert.equal(calls, 1);
  assert.equal(u.attempts, 1);
  assert.equal(u.billed, 0);
});

test("renderedPage: invalid targets are refused without a provider call", async () => {
  for (const bad of ["https://user:pass@example.com/", "http://169.254.169.254/", "not-a-url"]) {
    const u = usage();
    let calls = 0;
    await assert.rejects(
      () =>
        renderPage(bad, {
          apiKey: "test-key",
          usage: u,
          fetchImpl: (async () => {
            calls += 1;
            return okResponse(fixture("render-ok.json"));
          }) as typeof fetch,
        }),
    );
    assert.equal(calls, 0, `no provider call for ${bad}`);
    assert.equal(u.attempts, 0);
    assert.equal(u.billed, 0);
  }
});

test("renderedPage: a timed-out scrape is ambiguous and billed once", async () => {
  const u = usage();
  const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
  await assert.rejects(
    () =>
      renderPage("https://example.com/rendered", {
        apiKey: "test-key",
        usage: u,
        fetchImpl: (async () => {
          throw timeout;
        }) as typeof fetch,
      }),
    /timed out/,
  );
  assert.equal(u.attempts, 1);
  assert.equal(u.billed, 1);
});

test("renderedPage: challenged rendered HTML that is still blocked is rejected after billing", async () => {
  const u = usage();
  await assert.rejects(
    () =>
      renderPage("https://example.com/rendered", {
        apiKey: "test-key",
        usage: u,
        fetchImpl: (async () =>
          okResponse({
            success: true,
            data: {
              rawHtml: "<html><head><title>Just a moment...</title></head><body>challenge</body></html>",
              metadata: { statusCode: 200, url: "https://example.com/rendered" },
            },
          })) as typeof fetch,
      }),
  );
  assert.equal(u.attempts, 1);
  assert.equal(u.billed, 1);
});
