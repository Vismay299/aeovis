import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectPage,
  auditOwnedPages,
  boundedResponseText,
} from "./technicalAudit.js";
import { parseRobotsTxt } from "../crawlers/robots.js";
test("R15: combined restrictions and canonical observations stay distinct from indexing and verified crawling", () => {
  const p = inspectPage({
    url: "https://example.com/page",
    html: '<meta name="robots" content="index,follow"><meta content="noindex,nosnippet" name="googlebot"><link href="/canonical" rel="canonical"><main data-nosnippet>Product facts</main>',
    headers: { "x-robots-tag": "max-snippet:0" },
    robots: parseRobotsTxt(
      "User-agent: GPTBot\nDisallow: /\nUser-agent: OAI-SearchBot\nAllow: /",
    ),
    robotsState: "found",
  });
  assert.equal(p.canonical, "https://example.com/canonical");
  assert.equal(p.indexing.state, "unknown");
  assert.equal(p.verified_crawler_fetch.state, "unobserved");
  assert.ok(p.issues.some((i) => i.code === "restrictive_directive"));
  assert.ok(p.issues.some((i) => i.code === "data_nosnippet"));
  assert.equal(p.robots.find((b) => b.name === "GPTBot").status, "blocked");
  assert.equal(p.robots.find((b) => b.name === "OAI-SearchBot").status, "open");
});
test("R15: valid JSON-LD with unsupported visible facts is flagged without a ranking promise", () => {
  const p = inspectPage({
    url: "https://example.com",
    html: '<main>A simple page</main><script type="application/ld+json">{"@type":"Product","name":"Unobserved product","price":"100"}</script>',
  });
  assert.equal(p.structured_data[0].parse_state, "valid_json");
  assert.ok(p.issues.some((i) => i.code === "structured_data_requires_review"));
  assert.equal(p.rendered_content.state, "unmeasured");
});
test("R15: scoped discovery and requests are bounded and a private redirect never reaches fetch", async () => {
  const calls = [];
  const audit = await auditOwnedPages({
    website: "https://93.184.216.34/",
    maxRequests: 4,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/robots.txt"))
        return new Response("", { status: 404 });
      if (String(url).endsWith("/sitemap.xml"))
        return new Response(
          "<urlset><loc>https://93.184.216.34/private</loc></urlset>",
        );
      if (String(url).endsWith("/private"))
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/metadata" },
        });
      return new Response(
        "<main>" + "Observed substantive content. ".repeat(20) + "</main>",
      );
    },
  });
  assert.ok(audit.scope.requests <= 4);
  assert.equal(
    calls.some((url) => url.includes("127.0.0.1")),
    false,
  );
  assert.equal(audit.scope.whole_site_audit, false);
  assert.equal(audit.pages[0].robots_state, "missing");
  assert.ok(audit.failures.some((f) => f.url?.endsWith("/private")));
});
test("R15: response size cap rejects oversized source before snapshotting", async () => {
  await assert.rejects(
    boundedResponseText(new Response("a".repeat(100)), 20),
    /capture limit/,
  );
});
