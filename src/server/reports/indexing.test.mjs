// F23-AC-15 (§8 Phase 2 P2.T3.S1): `/r` is private (robots disallow + noindex
// header), `/s` is noindex-only (header and meta, deliberately NOT disallowed
// so crawlers and preview bots read the tags), neither is in the sitemap, and
// the middleware matcher still covers only `/api/:path*`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NOINDEX_ROUTE_PREFIXES,
  PRIVATE_ROUTE_PREFIXES,
  getPublicUrlInventory,
  getRouteIndexingPolicy,
} from "../publicSite.js";
import robotsHandler from "../../app/robots.js";
import sitemapHandler from "../../app/sitemap.js";
import nextConfig from "../../../next.config.mjs";

const PROD_ENV = { NODE_ENV: "production" };

test("F23 — /r is a private prefix and /s is a noindex-only prefix", () => {
  assert.deepEqual(NOINDEX_ROUTE_PREFIXES, ["/s"]);
  assert.deepEqual(PRIVATE_ROUTE_PREFIXES.slice(0, 10), [
    "/ops",
    "/portal",
    "/dashboard",
    "/scan",
    "/api",
    "/login",
    "/signup",
    "/auth",
    "/onboarding",
    "/email",
  ]);
  assert.equal(PRIVATE_ROUTE_PREFIXES[PRIVATE_ROUTE_PREFIXES.length - 1], "/r");
});

test("F23 — robots data disallows /r and never disallows /s", () => {
  const robots = robotsHandler();
  assert.ok(robots.rules.disallow.includes("/r/"), "robots must disallow /r/");
  assert.ok(robots.rules.disallow.includes("/r$"), "robots must disallow bare /r");
  for (const entry of robots.rules.disallow) {
    const isSharePath = entry === "/s" || entry === "/s$" || entry === "/s/" || entry.startsWith("/s/");
    assert.ok(!isSharePath, `/s must never be disallowed in robots.txt (found ${entry})`);
  }
});

test("F23 — neither /r nor /s appears in the sitemap", () => {
  for (const entry of sitemapHandler()) {
    const pathname = new URL(entry.url).pathname;
    assert.ok(!/^\/(r|s)(\/|$)/.test(pathname), `${entry.url} must not be in the sitemap`);
  }
  for (const item of getPublicUrlInventory()) {
    assert.ok(!/^\/(r|s)(\/|$)/.test(item.path), `${item.path} must not be in the inventory`);
  }
});

test("F23 — getRouteIndexingPolicy answers share_link for /s paths", () => {
  assert.deepEqual(getRouteIndexingPolicy("/s/abc", PROD_ENV), {
    index: false,
    follow: false,
    disallowRobots: false,
    isAuthentication: false,
    reason: "share_link",
  });
  assert.deepEqual(getRouteIndexingPolicy("/s", PROD_ENV), {
    index: false,
    follow: false,
    disallowRobots: false,
    isAuthentication: false,
    reason: "share_link",
  });
});

test("F23 — /r stays private with the prefix boundary intact", () => {
  assert.equal(getRouteIndexingPolicy("/r", PROD_ENV).reason, "private_route");
  assert.equal(getRouteIndexingPolicy("/r/11111111-1111-1111-8111-111111111111", PROD_ENV).reason, "private_route");
  assert.equal(getRouteIndexingPolicy("/r/11111111-1111-1111-8111-111111111111", PROD_ENV).disallowRobots, true);
  // "/scan" is still private, and the boundary is exact: "/scandal" is public.
  assert.equal(getRouteIndexingPolicy("/scan", PROD_ENV).reason, "private_route");
  assert.equal(getRouteIndexingPolicy("/scan/example", PROD_ENV).reason, "private_route");
  assert.equal(getRouteIndexingPolicy("/scandal", PROD_ENV).reason, "public_indexable");
  assert.equal(getRouteIndexingPolicy("/s/abc", PROD_ENV).disallowRobots, false);
});

test("F23 — next.config maps /s/:path* and /r/:path* to X-Robots-Tag", async () => {
  const rules = await nextConfig.headers();
  const bySource = new Map(rules.map((rule) => [rule.source, rule.headers]));
  for (const source of ["/s/:path*", "/r/:path*"]) {
    const headers = bySource.get(source);
    assert.ok(headers, `${source} must have a header rule`);
    assert.ok(
      headers.some((header) => header.key === "X-Robots-Tag" && header.value === "noindex, nofollow"),
      `${source} must map to X-Robots-Tag: noindex, nofollow`
    );
  }
});

test("F23 — the middleware matcher still covers only /api/:path*", () => {
  // middleware.js binds next/server, which cannot load under plain node, so
  // the matcher is asserted on the source text instead of the module.
  const source = readFileSync(new URL("../../middleware.js", import.meta.url), "utf8");
  assert.match(source, /matcher:\s*\[\s*"\/api\/:path\*"\s*\]/);
});
