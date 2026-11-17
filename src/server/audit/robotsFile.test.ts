import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRobots,
  parseAuditRobots,
  crawlerAllows,
} from "./robotsFile.ts";

test("fetchRobots handles 200, 404, 500, timeout, and SSRF refusals", async () => {
  const mockFetch = async (url: string) => {
    if (url.includes("/200")) {
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => "User-agent: *\nAllow: /",
      };
    }
    if (url.includes("/404")) {
      return { status: 404, headers: new Headers(), text: () => "" };
    }
    if (url.includes("/500")) {
      return { status: 500, headers: new Headers(), text: () => "Server Error" };
    }
    if (url.includes("/timeout")) {
      throw new Error("ETIMEDOUT");
    }
    if (url.includes("/ssrf")) {
      throw new Error("url_blocked");
    }
    return { status: 400, headers: new Headers(), text: () => "" };
  };

  const r200 = await fetchRobots("https://example.com/200", { safeFetch: mockFetch as any });
  assert.equal(r200.status, "found");
  assert.equal(r200.httpStatus, 200);
  assert.ok(r200.text?.includes("User-agent"));

  const r404 = await fetchRobots("https://example.com/404", { safeFetch: mockFetch as any });
  assert.equal(r404.status, "missing");
  assert.equal(r404.httpStatus, 404);

  const r500 = await fetchRobots("https://example.com/500", { safeFetch: mockFetch as any });
  assert.equal(r500.status, "error");
  assert.equal(r500.httpStatus, 500);

  const rTimeout = await fetchRobots("https://example.com/timeout", { safeFetch: mockFetch as any });
  assert.equal(rTimeout.status, "unreachable");
  assert.equal(rTimeout.httpStatus, null);

  const rSsrf = await fetchRobots("https://example.com/ssrf", { safeFetch: mockFetch as any });
  assert.equal(rSsrf.status, "unreachable");
  assert.equal(rSsrf.httpStatus, null);
});

test("fetchRobots truncates robots.txt exceeding 512,000 bytes", async () => {
  let passedMaxBytes = 0;
  let passedTruncate = false;

  const mockFetch = async (url: string, opts: any) => {
    passedMaxBytes = opts.maxBytes;
    passedTruncate = opts.truncate;
    return {
      status: 200,
      headers: new Headers(),
      text: () => "User-agent: *\nDisallow: /",
    };
  };

  await fetchRobots("https://example.com", { safeFetch: mockFetch as any });
  assert.equal(passedMaxBytes, 512_000);
  assert.equal(passedTruncate, true);
});

test("parseAuditRobots flags HTML content as malformed", () => {
  const htmlRobots = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>Error page</body></html>`;
  const parsed = parseAuditRobots(htmlRobots);
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.empty, false);
});

test("crawlerAllows evaluates PerceevAudit access correctly", () => {
  const disallowAll = `User-agent: *\nDisallow: /`;
  const parsed1 = parseAuditRobots(disallowAll);
  assert.equal(crawlerAllows(parsed1, "https://example.com/"), false);
  assert.equal(crawlerAllows(parsed1, "https://example.com/blog"), false);

  const allowAudit = `User-agent: *\nDisallow: /\n\nUser-agent: PerceevAudit\nAllow: /`;
  const parsed2 = parseAuditRobots(allowAudit);
  assert.equal(crawlerAllows(parsed2, "https://example.com/blog"), true);
});
