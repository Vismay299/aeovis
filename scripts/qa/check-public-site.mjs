import assert from "node:assert/strict";
import { getPublicUrlInventory, PRIVATE_ROUTE_PREFIXES } from "../../src/server/publicSite.mjs";

const origin = process.argv[2] || "http://127.0.0.1:3328";
const read = (pathname, options = {}) => fetch(new URL(pathname, origin), {
  redirect: "manual", signal: AbortSignal.timeout(10_000), ...options,
});

for (const page of getPublicUrlInventory()) {
  const response = await read(page.path);
  assert.equal(response.status, 200, page.path);
  assert.equal(response.headers.get("x-robots-tag"), null, page.path);
  const html = await response.text();
  const canonical = /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/.exec(html)?.[1];
  assert.equal(canonical && new URL(canonical).href, new URL(page.url).href, page.path);
}
for (const path of ["/login", "/signup", "/scan", "/dashboard", "/dashboard/example", "/portal", "/portal/scans/example", "/ops/measurement", "/auth/reset", "/onboarding", "/api/health", "/r/00000000-0000-0000-0000-000000000000", "/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
  const response = await read(path);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", path);
}
const robots = await (await read("/robots.txt")).text();
for (const prefix of PRIVATE_ROUTE_PREFIXES) {
  assert.ok(robots.includes(`Disallow: ${prefix}$`), prefix);
  assert.ok(robots.includes(`Disallow: ${prefix}/`), prefix);
}
const sitemap = await (await read("/sitemap.xml")).text();
for (const page of getPublicUrlInventory()) assert.ok(sitemap.includes(`<loc>${page.url}</loc>`), page.path);
// Node fetch may replace a custom Host header; use HTTP directly to exercise
// the same alias-host request a reverse proxy would forward.
const aliasUrl = new URL("/demo?source=alias-check", origin);
const { request } = await import(aliasUrl.protocol === "https:" ? "node:https" : "node:http");
const alias = await new Promise((resolve, reject) => {
  const req = request(aliasUrl, { headers: { host: "www.perceev.com" }, signal: AbortSignal.timeout(10_000) }, (response) => {
    response.resume();
    resolve({ status: response.statusCode, location: response.headers.location });
  });
  req.on("error", reject);
  req.end();
});
assert.equal(alias.status, 308);
assert.equal(alias.location, "https://perceev.com/demo?source=alias-check");
console.log("Public-site HTTP checks passed: canonical HTML, bare/nested private headers, robots, sitemap and alias redirect.");
