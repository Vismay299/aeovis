import test from "node:test";
import assert from "node:assert/strict";
import { estimateSiteAudit, siteAuditInput } from "./siteAudit.ts";
import type { PricingContext } from "../pricedActions.ts";

const ctx: PricingContext = {
  brandKey: "audit-brand",
  admin: {} as PricingContext["admin"],
  env: {},
  now: new Date("2026-10-22T00:00:00.000Z"),
};

function estimate(input: unknown, options: { active?: boolean } = {}) {
  return estimateSiteAudit(ctx, siteAuditInput.parse(input), {
    lighthouseUnitUsd: 0.005,
    firecrawlUnitUsd: 0.005,
    hasActiveAudit: async () => options.active ?? false,
  });
}

test("site audit quote is free without paid options", async () => {
  const quote = await estimate({});
  assert.equal(quote.totalUsd, 0);
  assert.equal(quote.expectedUsd, null);
  assert.equal(quote.lines.length, 1);
  assert.equal(quote.lines[0]?.label, "Crawl up to 50 pages");
  assert.deepEqual(quote.units, [{ key: "pages", label: "Pages", count: 50 }]);
});

test("site audit Lighthouse quote covers twenty checks at the injected unit price", async () => {
  const quote = await estimate({ lighthouse: true });
  assert.equal(quote.totalUsd, 0.1);
  assert.equal(quote.lines[1]?.totalUsd, 0.1);
  assert.equal(quote.warnings.find((warning) => warning.code === "lighthouse_sample")?.message,
    "Lighthouse runs on up to 10 pages, one per page template, so you may pay for fewer than 20 checks.");
});

test("site audit rendering quote uses the injected Firecrawl unit price", async () => {
  const quote = await estimate({ renderJavaScript: true });
  assert.equal(quote.totalUsd, 0.25);
  assert.equal(quote.lines[1]?.label, "Pages loaded by a browser service");
  assert.equal(quote.lines[1]?.totalUsd, 0.25);
});

test("site audit combined paid options sum their lines", async () => {
  const quote = await estimate({ lighthouse: true, renderJavaScript: true });
  assert.equal(quote.totalUsd, 0.35);
});

test("rendering over 1,000 pages is blocked", async () => {
  const quote = await estimate({ maxPages: 1_001, renderJavaScript: true });
  assert.equal(quote.blocked?.code, "render_page_limit");
});

test("an active audit blocks a new audit quote", async () => {
  const quote = await estimate({}, { active: true });
  assert.equal(quote.blocked?.code, "audit_already_running");
});
