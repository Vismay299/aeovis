// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/lighthouse.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLighthouseResult, selectLighthouseSample } from "./lighthouse.ts";

const okPage = (url: string) => ({ url, statusCode: 200, fetchClass: "ok" as const });

test("does not spend checks on a bot challenge that answered 200", () => {
  const selected = selectLighthouseSample(
    [{ ...okPage("https://example.com/"), fetchClass: "blocked" }, okPage("https://example.com/about")],
    "https://example.com/",
    "auto",
  );
  assert.deepEqual(selected, ["https://example.com/about"]);
});

test("includes a start page reached through a trailing-slash redirect", () => {
  const pages = [
    ...Array.from({ length: 10 }, (_, i) => okPage(`https://example.com/section${i}`)),
    okPage("https://example.com/services/"),
  ];
  const selected = selectLighthouseSample(pages, "https://example.com/services", "auto");
  assert.equal(selected.length, 10);
  assert.equal(selected[0], "https://example.com/services/");
});

test("prefers an exact start page when both slash forms return 2xx", () => {
  const selected = selectLighthouseSample(
    [okPage("https://example.com/services/"), okPage("https://example.com/services")],
    "https://example.com/services",
    "auto",
  );
  assert.equal(selected[0], "https://example.com/services");
});

test("does not sample another page from the start page's template", () => {
  const selected = selectLighthouseSample(
    [okPage("https://example.com/products/123"), okPage("https://example.com/products/456"), okPage("https://example.com/about")],
    "https://example.com/products/123",
    "auto",
  );
  assert.deepEqual(selected, ["https://example.com/products/123", "https://example.com/about"]);
});

test("does not retry an ambiguous generic failure", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return {
      data: {
        scores: { performance: 90, accessibility: 91, "best-practices": 92, seo: 93 },
        metrics: {
          largestContentfulPaint: { numericValue: 1000 },
          cumulativeLayoutShift: { numericValue: 0.01 },
          interactionToNextPaint: { numericValue: 100 },
          serverResponseTime: { numericValue: 200 },
        },
      },
    };
  };
  const fetched = await fetchLighthouseResult("https://example.com/", "page-1", "desktop", fetcher as never);
  assert.equal(calls, 1);
  assert.equal(fetched.result.errorMessage, "temporary failure");
});
