// Static coverage and fixture harness test for Perceev site-audit fixtures.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_ISSUE_TYPES, type AuditIssueType } from "../../../src/shared/audit-issues.ts";
import { FIXTURES } from "./registry.ts";
import { SITES } from "./sites.ts";
import { startFixtureServer } from "./server.ts";
import { fixtureFetch, fixtureLookup } from "./fixtureFetch.ts";

describe("site-audit fixtures and registry", () => {
  it("covers 100% of all AUDIT_ISSUE_TYPES across fixtures and sites", () => {
    const allIssueTypes = Object.keys(AUDIT_ISSUE_TYPES) as AuditIssueType[];
    const covered = new Set<AuditIssueType>();

    for (const fixture of FIXTURES) {
      for (const issue of fixture.expectedIssues) {
        covered.add(issue);
      }
    }

    for (const site of Object.values(SITES)) {
      for (const issue of site.expectedSiteIssues) {
        covered.add(issue);
      }
    }

    const uncovered = allIssueTypes.filter((type) => !covered.has(type));

    assert.equal(
      uncovered.length,
      0,
      `Uncovered issue types in fixture site: ${uncovered.join(", ")}`,
    );
    assert.equal(
      covered.size,
      allIssueTypes.length,
      `Expected ${allIssueTypes.length} issue types to be covered, got ${covered.size}`,
    );
  });

  it("ensures every fixture has unique path per site and valid metadata", () => {
    const pathsBySite = new Map<string, Set<string>>();

    for (const fixture of FIXTURES) {
      const site = fixture.site ?? "main";
      if (!pathsBySite.has(site)) {
        pathsBySite.set(site, new Set());
      }
      const seen = pathsBySite.get(site)!;
      assert.ok(!seen.has(fixture.path), `Duplicate path ${fixture.path} on site ${site}`);
      seen.add(fixture.path);

      assert.ok(fixture.name && fixture.name.length > 0, `Fixture at ${fixture.path} missing name`);
      assert.ok(fixture.path.startsWith("/"), `Fixture path ${fixture.path} must start with /`);
    }
  });

  it("serves fixtures and virtual hosts through loopback server", async () => {
    const server = await startFixtureServer();
    const fetchImpl = fixtureFetch(server.origin);

    try {
      // 1. Robots.txt on main
      const robotsRes = await fetchImpl("http://main.audit.test/robots.txt");
      assert.equal(robotsRes.status, 200);
      const robotsText = await robotsRes.text();
      assert.ok(robotsText.includes("User-agent: *"));

      // 2. Robots 500 site
      const robots500Res = await fetchImpl("http://robots500.audit.test/robots.txt");
      assert.equal(robots500Res.status, 500);

      // 3. Robots HTML site
      const robotsHtmlRes = await fetchImpl("http://robotshtml.audit.test/robots.txt");
      assert.equal(robotsHtmlRes.status, 200);
      assert.equal(robotsHtmlRes.headers.get("content-type"), "text/html");

      // 4. Llms bad site
      const llmsBadRes = await fetchImpl("http://llmsbad.audit.test/llms.txt");
      assert.equal(llmsBadRes.status, 200);
      assert.equal(llmsBadRes.headers.get("content-type"), "text/html");

      // 5. Throttled site (429)
      const throttledRes = await fetchImpl("http://throttled.audit.test/some-page");
      assert.equal(throttledRes.status, 429);
      assert.equal(throttledRes.headers.get("retry-after"), "7200");

      // 6. Page fixture on main
      const pageRes = await fetchImpl("http://main.audit.test/head/missing-title");
      assert.equal(pageRes.status, 200);
      const pageHtml = await pageRes.text();
      assert.ok(pageHtml.includes("Page with Missing Title"));

      // 7. Fixture lookup
      const ips = await fixtureLookup("main.audit.test");
      assert.deepEqual(ips, ["93.184.216.34"]);
    } finally {
      await server.close();
    }
  });
});
